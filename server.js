
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();

app.disable("x-powered-by");

// Environment variables
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

const razorpay = keyId && keySecret
  ? new Razorpay({
      key_id: keyId,
      key_secret: keySecret
    })
  : null;

// CORS
const allowedOrigins = new Set([
  "https://royalsteel.in",
  "https://www.royalsteel.in"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed"
    });
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "10kb" }));

// Supabase configuration
function checkConfiguration() {
  if (!razorpay) {
    throw new Error("Razorpay is not configured");
  }

  if (!supabaseUrl || !supabaseSecret) {
    throw new Error("Supabase is not configured");
  }
}

// Supabase REST helper
async function supabaseRequest(path, options = {}) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        "apikey": supabaseSecret,
        "Authorization": `Bearer ${supabaseSecret}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        ...(options.headers || {})
      }
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Supabase request failed:", response.status);
    throw new Error("Database operation failed");
  }

  return data;
}

// Health check
app.get("/", (req, res) => {
  res.json({
    service: "ROYALSTEEL Payment Backend",
    status: "running"
  });
});

// Trusted product catalogue
const trustedProducts = {
  1: { name: "Butterfly Bed", price: 49999 },
  2: { name: "Royal Sofa", price: 7999 },
  3: { name: "King Chair", price: 3999 },
  4: { name: "Dining Table", price: 6999 }
};

// Create Razorpay order and save pending order
app.post("/create-order", async (req, res) => {
  try {
    checkConfiguration();

    const {
      items,
      receipt,
      customerName,
      customerPhone,
      customerEmail,
      deliveryAddress,
      notes
    } = req.body || {};

    if (
      typeof customerName !== "string" ||
      customerName.trim().length < 2 ||
      customerName.trim().length > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid customer name is required"
      });
    }

    const phone = String(customerPhone || "").replace(/\D/g, "");

    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Valid customer phone is required"
      });
    }

    if (
      customerEmail &&
      (
        typeof customerEmail !== "string" ||
        customerEmail.length > 150 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address"
      });
    }

    if (
      deliveryAddress &&
      (
        typeof deliveryAddress !== "string" ||
        deliveryAddress.length > 1000
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid delivery address"
      });
    }

    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 20
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid cart"
      });
    }

    let totalRupees = 0;
    const orderItems = [];

    for (const item of items) {
      if (
        !item ||
        !Number.isSafeInteger(item.productId) ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 20
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product or quantity"
        });
      }

      const product = trustedProducts[item.productId];

      if (!product) {
        return res.status(400).json({
          success: false,
          message: "Unknown product"
        });
      }

      totalRupees += product.price * item.quantity;

      orderItems.push({
        name: product.name,
        quantity: item.quantity,
        price: product.price
      });
    }

    const amount = totalRupees * 100;

    if (
      !Number.isSafeInteger(amount) ||
      amount < 100 ||
      amount > 100000000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid total amount"
      });
    }

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt:
        typeof receipt === "string" &&
        /^[a-zA-Z0-9_-]{1,40}$/.test(receipt)
          ? receipt
          : `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
    });

    // Save pending order in Supabase
    const dbOrder = await supabaseRequest("orders", {
      method: "POST",
      body: JSON.stringify([{
        customer_name: customerName.trim(),
        customer_phone: phone,
        customer_email: customerEmail || null,
        delivery_address: deliveryAddress || null,
        product_name: orderItems.map(
          item => `${item.name} x ${item.quantity}`
        ).join(", "),
        quantity: orderItems.reduce(
          (sum, item) => sum + item.quantity, 0
        ),
        unit_price: orderItems.length === 1
          ? orderItems[0].price
          : 0,
        total_amount: totalRupees,
        order_status: "pending",
        payment_status: "unpaid",
        razorpay_order_id: order.id,
        notes: typeof notes === "string"
          ? notes.slice(0, 1000)
          : null
      }])
    });

    if (!dbOrder || !dbOrder.length) {
      throw new Error("Order was not saved");
    }

    return res.json({
      success: true,
      key_id: keyId,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency
      },
      database_order_id: dbOrder[0].id
    });

  } catch (error) {
    console.error(
      "Order creation failed:",
      error.message || "Unknown error"
    );

    return res.status(500).json({
      success: false,
      message: "Could not create and save order"
    });
  }
});

// Verify payment and update Supabase
app.post("/verify-payment", async (req, res) => {
  try {
    checkConfiguration();

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body || {};

    if (
      typeof razorpay_order_id !== "string" ||
      typeof razorpay_payment_id !== "string" ||
      typeof razorpay_signature !== "string" ||
      !/^order_[a-zA-Z0-9]+$/.test(razorpay_order_id) ||
      !/^pay_[a-zA-Z0-9]+$/.test(razorpay_payment_id) ||
      !/^[a-fA-F0-9]{64}$/.test(razorpay_signature)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment details"
      });
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest();

    const receivedSignature = Buffer.from(
      razorpay_signature,
      "hex"
    );

    if (
      expectedSignature.length !== receivedSignature.length ||
      !crypto.timingSafeEqual(
        expectedSignature,
        receivedSignature
      )
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment signature verification failed"
      });
    }

    const order = await razorpay.orders.fetch(
      razorpay_order_id
    );

    const payment = await razorpay.payments.fetch(
      razorpay_payment_id
    );

    if (
      payment.order_id !== order.id ||
      payment.status !== "captured" ||
      payment.amount !== order.amount ||
      payment.currency !== order.currency
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment details do not match"
      });
    }

    // Find matching saved order
    const query = new URLSearchParams({
      select: "id",
      razorpay_order_id: `eq.${razorpay_order_id}`,
      limit: "1"
    });

    const existing = await supabaseRequest(
      `orders?${query.toString()}`,
      { method: "GET" }
    );

    if (!existing || existing.length !== 1) {
      return res.status(404).json({
        success: false,
        verified: false,
        message: "Saved order not found"
      });
    }

    // Mark order as paid
    const updateQuery = new URLSearchParams({
      razorpay_order_id: `eq.${razorpay_order_id}`
    });

    await supabaseRequest(
      `orders?${updateQuery.toString()}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          payment_status: "paid",
          order_status: "confirmed",
          payment_id: payment.id,
          updated_at: new Date().toISOString()
        })
      }
    );

    return res.json({
      success: true,
      verified: true,
      message: "Payment verified and order saved",
      payment_id: payment.id,
      order_id: order.id
    });

  } catch (error) {
    console.error(
      "Payment verification failed:",
      error.message || "Unknown error"
    );

    return res.status(500).json({
      success: false,
      message: "Could not verify payment"
    });
  }
});

module.exports = app;



