const express = require('express');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Parse full HTTP headers to extract Authorization and Cookie
function parseHeadersFromEnv(headersStr) {
  const result = { basicAuth: '', cookies: '' };
  if (!headersStr) return result;
  
  const lines = headersStr.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Extract Authorization: Basic ...
    if (trimmed.toLowerCase().startsWith('authorization:')) {
      const value = trimmed.substring('authorization:'.length).trim();
      if (value.toLowerCase().startsWith('basic ')) {
        result.basicAuth = value.substring('basic '.length).trim();
      }
    }
    
    // Extract Cookie: ...
    if (trimmed.toLowerCase().startsWith('cookie:')) {
      result.cookies = trimmed.substring('cookie:'.length).trim();
    }
  }
  
  return result;
}

// Parse headers from PSS_HEADERS env variable
const parsedHeaders = parseHeadersFromEnv(process.env.PSS_HEADERS);

// Configuration - All sensitive data from environment variables
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK || "",
  checkoutUrl: "https://www.privatesportshop.fr/checkout/cart",
  cartReservationMinutes: 15,
  checkIntervalMs: 60 * 1000,
  // Basic auth for cart operations (parsed from headers or direct env)
  basicAuth: parsedHeaders.basicAuth || process.env.PSS_BASIC_AUTH || "",
  // Cookies including access_token (parsed from headers or direct env)
  cookies: parsedHeaders.cookies || process.env.PSS_COOKIES || "",
  storeId: "20",
  shipment: "FR"
};

// Store monitored products
const monitoredProducts = new Map();

// Product history (persists across monitoring sessions)
const productHistory = new Map();

// Monitoring interval reference
let monitoringInterval = null;

// Token expired notification tracking
let tokenExpiredNotified = false;

// Add product to history
function addToHistory(productId, productInfo, sizeMapping) {
  productHistory.set(productId, {
    productId,
    title: productInfo.title || `Produit ${productId}`,
    brand: productInfo.brand,
    price: productInfo.price,
    originalPrice: productInfo.originalPrice,
    discount: productInfo.discount,
    imageUrl: productInfo.imageUrl,
    sizeMapping,
    addedAt: new Date().toISOString(),
    lastMonitored: new Date().toISOString()
  });
}

// ============== PRIVATESPORTSHOP API FUNCTIONS ==============

function getTimestamp() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function makeRequest(method, path, body = null, useBasicAuth = false) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const isFormData = body && typeof body === 'string';

    const headers = {
      'Host': 'raven.privatesportshop.fr',
      'Accept': 'application/json',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': 'SportScape/3.14.0 PSS iOS (26.2)',
      'Connection': 'keep-alive',
      'Content-Type': isFormData ? 'application/x-www-form-urlencoded' : 'application/json'
    };

    if (CONFIG.cookies) {
      headers['Cookie'] = CONFIG.cookies;
    }

    if (useBasicAuth && CONFIG.basicAuth) {
      headers['Authorization'] = `Basic ${CONFIG.basicAuth}`;
    }

    if (postData) {
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const options = {
      hostname: 'raven.privatesportshop.fr',
      port: 443,
      path: path,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = [];

      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        try {
          const buffer = Buffer.concat(data);
          let responseText;
          
          // Handle gzip/deflate
          const encoding = res.headers['content-encoding'];
          if (encoding === 'gzip') {
            const zlib = require('zlib');
            responseText = zlib.gunzipSync(buffer).toString('utf8');
          } else if (encoding === 'deflate') {
            const zlib = require('zlib');
            responseText = zlib.inflateSync(buffer).toString('utf8');
          } else if (encoding === 'br') {
            const zlib = require('zlib');
            responseText = zlib.brotliDecompressSync(buffer).toString('utf8');
          } else {
            responseText = buffer.toString('utf8');
          }

          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${responseText}`));
            return;
          }

          const json = JSON.parse(responseText);
          resolve(json);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function fetchProductDetails(productId) {
  console.log(`[${getTimestamp()}] Fetching product ${productId}...`);
  
  const path = `/api/7/v2.0.0/products/${productId}/?shipment=${CONFIG.shipment}&store_id=${CONFIG.storeId}`;
  const data = await makeRequest('GET', path);
  
  // Parse product info
  const productInfo = {
    productId: data.entity_id || data.productID || productId,
    title: data.name || 'Unknown',
    brand: data.brand?.name || 'Unknown',
    price: data.prices?.current || data.prices?.specialPrice,
    originalPrice: data.prices?.old || data.prices?.retailPrice,
    discount: data.prices?.discount ? `${data.prices.discount}%` : null,
    imageUrl: data.images?.[0] || data.thumbnails?.[0] || null,
    inStock: data.inStock || data.in_stock === "1",
    productType: data.product_type,
    description: data.description
  };

  // Parse size options
  const sizeMapping = {};
  const stockInfo = {};
  
  if (data.options) {
    const sizeOption = data.options.find(opt => opt.code === 'size');
    if (sizeOption && sizeOption.values) {
      for (const sizeValue of sizeOption.values) {
        const sizeId = sizeValue.id.toString();
        sizeMapping[sizeId] = {
          size: sizeValue.value,
          productId: sizeValue.product_id
        };
        // We assume if it's listed, it has stock (API doesn't give per-size stock directly)
        // We'll need to check each variant separately if needed
        stockInfo[sizeId] = {
          inStock: true,
          quantity: 1 // Default to 1, actual quantity not always available
        };
      }
    }
  }

  // Track if product has any stock at all
  const hasAnySizes = Object.keys(sizeMapping).length > 0;
  
  console.log(`[${getTimestamp()}] Found ${Object.keys(sizeMapping).length} sizes for ${productInfo.brand} - ${productInfo.title} (inStock: ${productInfo.inStock}, hasSizes: ${hasAnySizes})`);
  
  return { productInfo, sizeMapping, stockInfo };
}

async function addToCart(productId, sizeId) {
  console.log(`[${getTimestamp()}] Adding to cart: product ${productId}, size ${sizeId}`);
  
  const formData = `productID=${productId}&quantity=1&options%5Bsize%5D=${sizeId}`;
  
  try {
    const result = await makeRequest('POST', '/api/7/v2.0.0/basket/add/', formData, true);
    
    if (result.success) {
      console.log(`[${getTimestamp()}] ✅ Added to cart successfully!`);
      return {
        success: true,
        message: result.message || 'Added to cart',
        count: result.count
      };
    } else {
      throw new Error(result.message || 'Failed to add to cart');
    }
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Add to cart failed:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

async function sendDiscordNotification(productInfo, sizeId, sizeName, quantity, productUrl) {
  if (!CONFIG.discordWebhook) {
    console.log(`[${getTimestamp()}] Discord webhook not configured, skipping notification`);
    return;
  }

  const embed = {
    title: `🚨 Stock Alert: ${productInfo.brand}`,
    description: `**${productInfo.title}**`,
    color: 0x00AA00,
    fields: [
      { name: '📏 Taille', value: sizeName, inline: true },
      { name: '📦 Quantité', value: quantity.toString(), inline: true },
      { name: '💰 Prix', value: productInfo.price || 'N/A', inline: true }
    ],
    thumbnail: productInfo.imageUrl ? { url: productInfo.imageUrl } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: 'PrivateSportShop Stock Monitor' }
  };

  if (productInfo.discount) {
    embed.fields.push({ name: '🏷️ Remise', value: productInfo.discount, inline: true });
  }

  // Add links
  embed.fields.push(
    { name: '🔗 Produit', value: `[Voir le produit](${productUrl})`, inline: true },
    { name: '🛒 Panier', value: `[Aller au panier](${CONFIG.checkoutUrl})`, inline: true }
  );

  const payload = {
    username: 'PSS Stock Monitor',
    embeds: [embed]
  };

  return new Promise((resolve) => {
    const url = new URL(CONFIG.discordWebhook);
    const postData = JSON.stringify(payload);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });

    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

async function sendTokenExpiredNotification(errorMessage) {
  if (tokenExpiredNotified || !CONFIG.discordWebhook) return;
  
  tokenExpiredNotified = true;
  
  const payload = {
    username: 'PSS Stock Monitor',
    embeds: [{
      title: '⚠️ Token Expiré - Action Requise',
      description: 'Le token d\'authentification a expiré. Veuillez le mettre à jour.',
      color: 0xFF0000,
      fields: [
        { name: 'Erreur', value: errorMessage.substring(0, 200), inline: false }
      ],
      timestamp: new Date().toISOString()
    }]
  };

  return new Promise((resolve) => {
    const url = new URL(CONFIG.discordWebhook);
    const postData = JSON.stringify(payload);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });

    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

function resetTokenExpiredFlag() {
  tokenExpiredNotified = false;
}

// ============== MONITORING ==============

async function monitorAllProducts() {
  if (monitoredProducts.size === 0) return;

  console.log(`[${getTimestamp()}] 🔄 Checking ${monitoredProducts.size} product(s)...`);

  for (const [key, product] of monitoredProducts) {
    try {
      const { productInfo, sizeMapping, stockInfo } = await fetchProductDetails(product.productId);
      
      const productUrl = `https://www.privatesportshop.fr/catalog/product/view/id/${product.productId}`;
      const hasSizes = Object.keys(sizeMapping).length > 0;

      // WatchAll mode: monitor for ANY stock (for out-of-stock products)
      if (product.watchAll) {
        const hadSizesBefore = product.hadSizes;
        
        // Product went from no-sizes to having-sizes = BACK IN STOCK!
        if (!hadSizesBefore && hasSizes) {
          console.log(`[${getTimestamp()}] 🚨 RESTOCK DETECTED: ${productInfo.brand} - ${productInfo.title} now has ${Object.keys(sizeMapping).length} sizes!`);
          
          // Notify for each available size and try to add one to cart
          let addedToCart = false;
          for (const [sizeId, sizeInfo] of Object.entries(sizeMapping)) {
            if (!addedToCart) {
              const cartResult = await addToCart(product.productId, sizeId);
              if (cartResult.success) {
                await sendDiscordNotification(productInfo, sizeId, sizeInfo.size, 1, productUrl);
                product.notified.add(sizeId);
                addedToCart = true;
                console.log(`[${getTimestamp()}] 📢 Discord notification sent for restock!`);
              }
            }
          }
          
          // Update hadSizes so we don't notify again
          product.hadSizes = true;
        }
        
        // Product went from having-sizes to no-sizes = OUT OF STOCK
        if (hadSizesBefore && !hasSizes) {
          console.log(`[${getTimestamp()}] ⚠️ ${productInfo.brand} - ${productInfo.title} is now out of stock`);
          product.hadSizes = false;
          product.notified.clear(); // Reset so we notify again when back in stock
        }
      }

      // Normal mode: Check each watched size
      for (const sizeId of product.watchedSizes) {
        const currentStock = stockInfo[sizeId];
        const previousStock = product.previousStock[sizeId];
        const sizeName = sizeMapping[sizeId]?.size || sizeId;

        const wasInStock = previousStock?.inStock;
        const nowInStock = currentStock?.inStock;

        // New stock detected
        if (nowInStock && !wasInStock && !product.notified.has(sizeId)) {
          console.log(`[${getTimestamp()}] 🚨 NEW STOCK: ${productInfo.brand} - ${productInfo.title} - Size ${sizeName}`);
          
          // Try to add to cart
          const cartResult = await addToCart(product.productId, sizeId);
          
          if (cartResult.success) {
            await sendDiscordNotification(
              productInfo,
              sizeId,
              sizeName,
              currentStock.quantity || 1,
              productUrl
            );
            product.notified.add(sizeId);
            console.log(`[${getTimestamp()}] 📢 Discord notification sent!`);
          }
        }

        // Reset notification if item goes out of stock
        if (product.notified.has(sizeId) && !nowInStock) {
          product.notified.delete(sizeId);
        }
      }

      product.previousStock = stockInfo;
      product.productInfo = productInfo;
      product.sizeMapping = sizeMapping;
      
    } catch (error) {
      console.error(`[${getTimestamp()}] Error monitoring ${key}:`, error.message);
      
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes('unauthorized') || 
          errorMsg.includes('401') || 
          errorMsg.includes('403') ||
          errorMsg.includes('token') ||
          errorMsg.includes('auth') ||
          errorMsg.includes('expired')) {
        await sendTokenExpiredNotification(error.message);
      }
    }
  }
}

function startMonitoring() {
  if (!monitoringInterval) {
    monitoringInterval = setInterval(monitorAllProducts, CONFIG.checkIntervalMs);
    console.log(`[${getTimestamp()}] ⏰ Monitoring started (every ${CONFIG.checkIntervalMs / 1000}s)`);
  }
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log(`[${getTimestamp()}] ⏹️ Monitoring stopped`);
  }
}

// ============== API ENDPOINTS ==============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    monitoring: !!monitoringInterval,
    productsCount: monitoredProducts.size,
    hasAuth: !!CONFIG.basicAuth,
    hasCookies: !!CONFIG.cookies,
    hasDiscord: !!CONFIG.discordWebhook
  });
});

app.get('/ping', (req, res) => res.send('pong'));

// Get all monitored products
app.get('/api/products', (req, res) => {
  const products = [];
  for (const [key, product] of monitoredProducts) {
    products.push({
      key,
      productId: product.productId,
      productInfo: product.productInfo,
      sizeMapping: product.sizeMapping,
      watchedSizes: Array.from(product.watchedSizes),
      watchAll: product.watchAll || false,
      hadSizes: product.hadSizes,
      currentStock: product.previousStock,
      notified: Array.from(product.notified)
    });
  }
  res.json({ products, isMonitoring: !!monitoringInterval });
});

// Parse product URL
function parseProductUrl(url) {
  // Format: https://www.privatesportshop.fr/catalog/product/view/id/3158263
  const match = url.match(/\/id\/(\d+)/);
  if (match) {
    return match[1];
  }
  // Also try query param format
  const urlObj = new URL(url);
  const id = urlObj.searchParams.get('id');
  if (id) return id;
  
  return null;
}

// Fetch product details
app.post('/api/products/fetch', async (req, res) => {
  try {
    let { productId, url } = req.body;
    
    // If URL is provided, parse it
    if (url && !productId) {
      productId = parseProductUrl(url);
      if (!productId) {
        return res.status(400).json({ error: 'Invalid PrivateSportShop URL format' });
      }
    }
    
    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required (or provide URL)' });
    }

    const { productInfo, sizeMapping, stockInfo } = await fetchProductDetails(productId);
    
    const hasSizes = Object.keys(sizeMapping).length > 0;
    
    res.json({
      productId,
      productInfo,
      inStock: productInfo.inStock,
      hasSizes,
      sizes: Object.entries(sizeMapping).map(([sizeId, info]) => ({
        sizeId,
        size: info.size,
        productId: info.productId,
        stock: stockInfo[sizeId] || { inStock: false, quantity: 0 }
      }))
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Fetch error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Add product to monitoring
app.post('/api/products/add', async (req, res) => {
  try {
    const { productId, watchedSizes, watchAll } = req.body;
    
    // Allow monitoring without sizes if watchAll is true (for out-of-stock products)
    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }
    
    if (!watchAll && (!watchedSizes || !Array.isArray(watchedSizes) || watchedSizes.length === 0)) {
      return res.status(400).json({ error: 'watchedSizes array is required (or set watchAll: true for out-of-stock products)' });
    }

    const key = productId.toString();
    
    const { productInfo, sizeMapping, stockInfo } = await fetchProductDetails(productId);
    
    const notifiedSet = new Set();
    const productUrl = `https://www.privatesportshop.fr/catalog/product/view/id/${productId}`;
    const hasSizes = Object.keys(sizeMapping).length > 0;
    
    // If watchAll mode and product now has sizes, notify immediately
    if (watchAll && hasSizes) {
      console.log(`[${getTimestamp()}] 🚨 Product ${productInfo.brand} - ${productInfo.title} has ${Object.keys(sizeMapping).length} sizes available!`);
      
      // Add all available sizes to cart and notify
      for (const [sizeId, sizeInfo] of Object.entries(sizeMapping)) {
        const cartResult = await addToCart(productId, sizeId);
        if (cartResult.success) {
          await sendDiscordNotification(productInfo, sizeId, sizeInfo.size, 1, productUrl);
          notifiedSet.add(sizeId);
          break; // Only add one size to cart
        }
      }
    }
    
    // Check if any watched size is already in stock (normal mode)
    if (watchedSizes && watchedSizes.length > 0) {
      for (const sizeId of watchedSizes) {
        const stock = stockInfo[sizeId];
        if (stock && stock.inStock) {
          const sizeName = sizeMapping[sizeId]?.size || sizeId;
          console.log(`[${getTimestamp()}] 🚨 Size ${sizeName} already in stock - sending notification!`);
          
          // Try to add to cart
          const cartResult = await addToCart(productId, sizeId);
          
          if (cartResult.success) {
            await sendDiscordNotification(productInfo, sizeId, sizeName, stock.quantity || 1, productUrl);
            notifiedSet.add(sizeId);
          }
        }
      }
    }
    
    monitoredProducts.set(key, {
      productId,
      productInfo,
      sizeMapping,
      watchedSizes: watchedSizes ? new Set(watchedSizes) : new Set(),
      watchAll: !!watchAll, // Monitor for ANY stock (for out-of-stock products)
      hadSizes: hasSizes, // Track if product had sizes when added
      previousStock: stockInfo,
      notified: notifiedSet
    });
    
    // Save to history
    addToHistory(productId, productInfo, sizeMapping);

    startMonitoring();

    const mode = watchAll ? 'watchAll' : 'watchSizes';
    const message = watchAll 
      ? `Monitoring ${productInfo.brand} - ${productInfo.title} for ANY stock (currently ${hasSizes ? 'in stock' : 'out of stock'})`
      : `Now monitoring ${productInfo.brand} - ${productInfo.title}`;
    
    res.json({ 
      success: true, 
      message,
      mode,
      inStock: hasSizes,
      watchedSizes: watchedSizes ? watchedSizes.map(id => sizeMapping[id]?.size || id) : [],
      availableSizes: Object.entries(sizeMapping).map(([id, info]) => ({ sizeId: id, size: info.size })),
      alreadyInStock: Array.from(notifiedSet).map(id => sizeMapping[id]?.size || id)
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Add product error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Remove product from monitoring
app.delete('/api/products/:key', (req, res) => {
  const { key } = req.params;
  
  if (monitoredProducts.has(key)) {
    monitoredProducts.delete(key);
    
    if (monitoredProducts.size === 0) {
      stopMonitoring();
    }
    
    res.json({ success: true, message: 'Product removed' });
  } else {
    res.status(404).json({ error: 'Product not found' });
  }
});

// Update watched sizes
app.put('/api/products/:key/sizes', (req, res) => {
  const { key } = req.params;
  const { watchedSizes } = req.body;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.watchedSizes = new Set(watchedSizes);
  
  res.json({ success: true, watchedSizes: Array.from(product.watchedSizes) });
});

// Reset notifications for a product
app.post('/api/products/:key/reset', (req, res) => {
  const { key } = req.params;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.notified.clear();
  
  res.json({ success: true, message: 'Notifications reset' });
});

// ============== HISTORY API ==============

app.get('/api/history', (req, res) => {
  const history = [];
  for (const [key, item] of productHistory) {
    history.push({
      key,
      productId: item.productId,
      title: item.title,
      brand: item.brand,
      price: item.price,
      originalPrice: item.originalPrice,
      discount: item.discount,
      sizeMapping: item.sizeMapping,
      addedAt: item.addedAt,
      lastMonitored: item.lastMonitored,
      isCurrentlyMonitored: monitoredProducts.has(key)
    });
  }
  history.sort((a, b) => new Date(b.lastMonitored) - new Date(a.lastMonitored));
  res.json({ history });
});

app.delete('/api/history', (req, res) => {
  productHistory.clear();
  res.json({ success: true, message: 'History cleared' });
});

app.delete('/api/history/:key', (req, res) => {
  const { key } = req.params;
  if (productHistory.has(key)) {
    productHistory.delete(key);
    res.json({ success: true, message: 'Item removed from history' });
  } else {
    res.status(404).json({ error: 'Item not found in history' });
  }
});

// ============== CONFIG API ==============

app.post('/api/config/auth', (req, res) => {
  const { headers, basicAuth, cookies } = req.body;
  
  // If full headers are provided, parse them
  if (headers) {
    const parsed = parseHeadersFromEnv(headers);
    if (parsed.basicAuth) {
      CONFIG.basicAuth = parsed.basicAuth;
      console.log(`[${getTimestamp()}] Basic auth updated from headers`);
    }
    if (parsed.cookies) {
      CONFIG.cookies = parsed.cookies;
      console.log(`[${getTimestamp()}] Cookies updated from headers`);
    }
  }
  
  // Direct values override parsed ones
  if (basicAuth) {
    CONFIG.basicAuth = basicAuth;
    console.log(`[${getTimestamp()}] Basic auth updated via API`);
  }
  
  if (cookies) {
    CONFIG.cookies = cookies;
    console.log(`[${getTimestamp()}] Cookies updated via API`);
  }
  
  resetTokenExpiredFlag();
  res.json({ success: true, message: 'Auth updated' });
});

app.post('/api/config/discord', (req, res) => {
  const { webhook } = req.body;
  
  if (!webhook) {
    return res.status(400).json({ error: 'Webhook URL is required' });
  }
  
  CONFIG.discordWebhook = webhook;
  console.log(`[${getTimestamp()}] Discord webhook updated via API`);
  
  res.json({ success: true, message: 'Discord webhook updated' });
});

// ============== START SERVER ==============

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🏃 PrivateSportShop Stock Monitor - Web Interface           ║
║  Server running on port ${PORT}                                  ║
║  Started at: ${new Date().toISOString()}                        
║  Health check: /health or /ping                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
