const express = require('express');
const { exec } = require("child_process");
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const FPGrowth = require('node-fpgrowth');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = 'products.json';
const TRANSACTIONS_FILE = 'transactions.json';

// Ensure products.json and transactions.json exist
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}
if (!fs.existsSync(TRANSACTIONS_FILE)) {
  fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify([]));
}

// Configure Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
// API Route to send SMS notifications
app.post("/product-expiration-system/notifications", (req, res) => {
    console.log("Received notification request");

    // Execute the Python script
    exec("python sms_alert.py", (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing script: ${error.message}`);
            return res.status(500).json({ success: false, message: "SMS sending failed", error: error.message });
        }
        if (stderr) {
            console.error(`Script Error: ${stderr}`);
            return res.status(500).json({ success: false, message: "SMS script error", error: stderr });
        }

        console.log(`SMS script output: ${stdout}`);
        res.json({ success: true, message: "SMS sent successfully", output: stdout });
    });
});


/**
 * POST /upload
 * Uploads and processes an Excel file.
 * Uses upsert logic (by product name, case-insensitive) so that reuploads update existing records.
 */
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // Read raw data with header: 1 (first row as header)
    let rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    console.log("Raw Data from Excel:", rawData);

    if (rawData.length < 2) {
      return res.status(400).json({ error: "Invalid Excel file, missing data." });
    }

    // Extract and normalize headers (trim and lowercase)
    const headers = rawData[0].map(header => header.trim().toLowerCase());
    console.log("Detected Headers:", headers);

    // Convert remaining rows into objects using headers
    let data = rawData.slice(1).map(row => {
      let rowData = {};
      headers.forEach((header, index) => {
        rowData[header] = row[index] || 'N/A';
      });
      return rowData;
    });
    console.log("Processed Data (Before Conversion):", data);

    // Convert expiryDate if numeric, ensure proper types for stock and price
    data = data.map(row => ({
      name: row['name'] || 'N/A',
      category: row['category'] || 'N/A',
      expiryDate: isNaN(row['expiry date'])
                  ? (row['expiry date'] || row['expirydate'] || 'N/A')
                  : new Date((row['expiry date'] - 25569) * 86400000)
                        .toISOString().split('T')[0],
      stock: parseInt(row['stock'], 10) || 0,
      price: parseFloat(row['price']) || 0.0,
    }));

    // Upsert logic: update if product exists (by name, case-insensitive), else add new.
    let existingData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || "[]");
    data.forEach(newProduct => {
      const newName = newProduct.name.trim().toLowerCase();
      if (newName === 'n/a') return; // Skip invalid rows
      const index = existingData.findIndex(existing =>
        existing.name && existing.name.trim().toLowerCase() === newName
      );
      if (index !== -1) {
        // Update the existing product with new data
        existingData[index] = newProduct;
      } else {
        // Add as new product
        existingData.push(newProduct);
      }
    });
    fs.writeFileSync(DATA_FILE, JSON.stringify(existingData, null, 2));

    res.json({ message: "Products uploaded successfully!", products: existingData });
  } catch (error) {
    console.error("Error processing file:", error);
    res.status(500).json({ error: "Failed to process file" });
  }
});

/**
 * GET /products
 * Returns all products.
 */
app.get('/products', (req, res) => {
  try {
    const products = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.json(products);
  } catch (error) {
    console.error("Error reading products.json:", error);
    res.status(500).json({ error: "Failed to load products" });
  }
});

/**
 * Get Expiring Products (Within a given number of Days)
 * Accepts an optional query parameter 'days'; defaults to 30 days.
 */
function getExpiringProducts(daysThreshold = 30) {
  const products = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const today = new Date();
  const thresholdDate = new Date();
  thresholdDate.setDate(today.getDate() + daysThreshold);
  // Only count products whose expiry date is between today and strictly before thresholdDate
  return products.filter(product => {
    if (product.expiryDate === 'N/A') return false;
    const expiryDate = new Date(product.expiryDate);
    return expiryDate >= today && expiryDate < thresholdDate;
  });
}

/**
 * GET /notifications
 * Returns products near expiry based on an optional 'days' query parameter.
 * The returned products are sorted in ascending order by expiry date.
 */
app.get('/notifications', (req, res) => {
  const daysThreshold = req.query.days ? parseInt(req.query.days) : 30;
  let expiringProducts = getExpiringProducts(daysThreshold);
  expiringProducts.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
  res.json(expiringProducts);
});
/**
 * GET /dashboard
 * Returns dashboard statistics:
 *  - Total Products
 *  - Low Stock Products (available stock < 10)
 *  - Expiring Soon (products with expiry date strictly before one month from today)
 */
app.get('/dashboard', (req, res) => {
  try {
    const products = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const totalProducts = products.length;
    const lowStockCount = products.filter(p => (p.stock - (p.sold || 0)) < 10).length;
   
    const today = new Date();
    const thresholdDate = new Date();
    thresholdDate.setDate(today.getDate() + 30);
    const expiringSoonCount = products.filter(p => {
      if (p.expiryDate === 'N/A') return false;
      const expiryDate = new Date(p.expiryDate);
      return expiryDate >= today && expiryDate < thresholdDate;
    }).length;
   
    res.json({ totalProducts, lowStockCount, expiringSoonCount });
  } catch (error) {
    console.error("Error loading dashboard data:", error);
    res.status(500).json({ error: "Failed to load dashboard data" });
  }
});

/**
 * Transaction Endpoints
 */
function getTransactionData() {
  if (!fs.existsSync(TRANSACTIONS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
}
function addTransaction(transaction) {
  const transactions = getTransactionData();
  transactions.push(transaction);
  fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2));
}

// POST /purchase: Record a purchase transaction.
app.post('/purchase', (req, res) => {
  const { products } = req.body;
  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Invalid purchase data" });
  }
  const newTransaction = {
    invoiceId: "INV-" + Date.now(),
    products,
    finalPrice: products.reduce((sum, p) => sum + p.total, 0),
    date: new Date().toISOString()
  };
  addTransaction(newTransaction);
  res.json({ message: "Purchase recorded successfully", transaction: newTransaction });
});

// GET /transactions: Returns all transactions.
app.get('/transactions', (req, res) => {
  try {
    const transactions = getTransactionData();
    res.json(transactions);
  } catch (error) {
    console.error("Error reading transactions:", error);
    res.status(500).json({ error: "Failed to load transactions" });
  }
});

/**
 * Generate Recommendations Using Market Basket Analysis
 * Uses transaction data (converted to arrays of lowercase product names)
 * and the FP-Growth algorithm to find frequent itemsets.
 */
async function generateRecommendations() {
  const transactions = getTransactionData().map(t => t.products.map(p => p.name.toLowerCase()));
  console.log("Transaction Data for FP-Growth:", transactions);
  const fpgrowth = new FPGrowth.FPGrowth(0.1); // Lower threshold for debugging

  return new Promise((resolve, reject) => {
    fpgrowth.exec(transactions)
      .then(frequentItemsets => {
        console.log("Frequent Itemsets:", frequentItemsets);
        const recommendations = {};
        frequentItemsets.forEach(itemset => {
          itemset.items.forEach(item => {
            if (!recommendations[item]) recommendations[item] = new Set();
            itemset.items.forEach(relatedItem => {
              if (relatedItem !== item) {
                recommendations[item].add(relatedItem);
              }
            });
          });
        });
        Object.keys(recommendations).forEach(item => {
          recommendations[item] = [...recommendations[item]].slice(0, 2);
        });
        console.log("Generated Recommendations:", recommendations);
        resolve(recommendations);
      })
      .catch(reject);
  });
}

/**
 * GET /recommendations
 * Returns recommendations for expiring products.
 * Accepts an optional 'days' query parameter to filter expiring products.
 * For each expiring product, calculates a discount based on price:
 *   Price < 50  → 5% off, 50-100 → 10% off, >100 → 15% off.
 * Also sorts the expiring products in ascending order by expiry date.
 */
app.get('/recommendations', async (req, res) => {
  try {
    const daysThreshold = req.query.days ? parseInt(req.query.days) : 30;
    let expiringProducts = getExpiringProducts(daysThreshold);
    expiringProducts.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
    const recommendations = await generateRecommendations();

    const recommendedItems = expiringProducts.map(product => {
      const price = parseFloat(product.price);
      let discountPercentage = 0;
      if (price < 50) {
        discountPercentage = 5;
      } else if (price < 100) {
        discountPercentage = 10;
      } else {
        discountPercentage = 15;
      }
      const discountedPrice = price - (price * discountPercentage / 100);
      return {
        product: product.name,
        expiryDate: product.expiryDate,
        price: product.price,
        discountPercentage,
        discountedPrice,
        recommended: recommendations[product.name.trim().toLowerCase()] || ["No recommendations"]
      };
    });
    res.json(recommendedItems);
  } catch (error) {
    console.error("Error generating recommendations:", error);
    res.status(500).json({ error: "Failed to generate recommendations" });
  }
});

/**
 * Serve Static HTML Pages from the "public" folder.
 */
app.get('/view-products', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view-products.html'));
});
app.get('/notifications.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'notifications.html'));
});
app.get('/recommendations.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'recommendations.html'));
});
app.get('/transactions.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'transaction.html'));
});
app.get('/logout.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logout.html'));
});
// Serve main page (dashboard)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product-management-system.html'));
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
