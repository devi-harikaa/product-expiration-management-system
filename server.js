const mongoose = require('mongoose'); 
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const connectDB = require("./config/db");
const fs = require('fs');
const path = require('path');
const FPGrowth = require('node-fpgrowth');
const twilio = require('twilio');
console.log('MONGO_URI:', process.env.MONGO_URI); // Debugging
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));
// Routes
const adminRoutes = require("./routes/admin");
const productRoutes = require("./routes/products");
app.use("/admin", adminRoutes);
app.use("/products", productRoutes);

const DATA_FILE = 'products.json';
const TRANSACTIONS_FILE = 'transactions.json';

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));
if (!fs.existsSync(TRANSACTIONS_FILE)) fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify([]));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
// Connect to MongoDB Atlas
connectDB();


// Twilio Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || "+91XXXXXXXXXX";

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/**
 * Helper Functions
 */
function getProducts() {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveProducts(products) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(products, null, 2));
}

function getTransactions() {
    return JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
}

function saveTransaction(transaction) {
    const transactions = getTransactions();
    transactions.push(transaction);
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2));
}

/**
 * GET /products
 */
app.get('/products', (req, res) => {
    try {
        res.json(getProducts());
    } catch (error) {
        console.error("Error reading products.json:", error);
        res.status(500).json({ error: "Failed to load products" });
    }
});

/**
 * GET /notifications
 */
app.get('/notifications', (req, res) => {
    const daysThreshold = req.query.days ? parseInt(req.query.days) : 30;
    const products = getProducts();
    
    const today = new Date();
    const thresholdDate = new Date();
    thresholdDate.setDate(today.getDate() + daysThreshold);
    
    const expiringProducts = products.filter(product => {
        if (product.expiryDate === 'N/A') return false;
        const expiryDate = new Date(product.expiryDate);
        return expiryDate >= today && expiryDate < thresholdDate;
    });

    res.json(expiringProducts);
});

/**
 * Send SMS Alerts for Expiring Products
 */
async function checkAndSendAlerts() {
    try {
        const expiringProducts = getProducts().filter(product => {
            if (product.expiryDate === 'N/A') return false;
            const expiryDate = new Date(product.expiryDate);
            const today = new Date();
            return expiryDate >= today && expiryDate <= new Date(today.setDate(today.getDate() + 30));
        });

        if (expiringProducts.length > 0) {
            let message = "⚠️ Expiry Alert:\n";
            expiringProducts.forEach(product => {
                message += `📌 ${product.name} (Expiry: ${product.expiryDate}, Stock: ${product.stock})\n`;
            });

            await twilioClient.messages.create({
                body: message,
                from: TWILIO_PHONE_NUMBER,
                to: ADMIN_PHONE_NUMBER
            });

            console.log("✅ SMS Sent Successfully:\n", message);
        } else {
            console.log("✅ No Expiring Products.");
        }
    } catch (error) {
        console.error("❌ Error Sending SMS:", error.message);
    }
}

// ✅ Run `checkAndSendAlerts()` every 5 minutes
setInterval(checkAndSendAlerts, 300000);

/**
 * POST /purchase
 */
app.post('/purchase', (req, res) => {
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ error: "Invalid purchase data" });
    }

    let productList = getProducts();

    // Update stock
    products.forEach(purchasedProduct => {
        let product = productList.find(p => p.name.toLowerCase() === purchasedProduct.name.toLowerCase());
        if (product && product.stock >= purchasedProduct.quantity) {
            product.stock -= purchasedProduct.quantity;
        }
    });

    saveProducts(productList);

    const newTransaction = {
        invoiceId: "INV-" + Date.now(),
        products,
        finalPrice: products.reduce((sum, p) => sum + p.total, 0),
        date: new Date().toISOString()
    };

    saveTransaction(newTransaction);
    res.json({ message: "Purchase recorded successfully", transaction: newTransaction });
});

/**
 * GET /transactions
 */
app.get('/transactions', (req, res) => {
    try {
        res.json(getTransactions());
    } catch (error) {
        console.error("Error reading transactions:", error);
        res.status(500).json({ error: "Failed to load transactions" });
    }
});

/**
 * Generate Product Recommendations
 */
async function generateRecommendations() {
    const transactions = getTransactions().map(t => t.products.map(p => p.name.toLowerCase()));

    console.log("Transaction Data for FP-Growth:", transactions);
    const fpgrowth = new FPGrowth.FPGrowth(0.1);

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
 */
app.get('/recommendations', async (req, res) => {
    try {
        const recommendations = await generateRecommendations();
        res.json(recommendations);
    } catch (error) {
        console.error("Error generating recommendations:", error);
        res.status(500).json({ error: "Failed to generate recommendations" });
    }
});

/**
 * GET /dashboard
 */
app.get('/dashboard', (req, res) => {
    try {
        const products = getProducts();
        const totalProducts = products.length;
        const lowStockCount = products.filter(p => p.stock < 10).length;

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
 * Start Server
 */
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
