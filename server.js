const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");

app.use(express.json({ limit: "10kb" }));

// Allow requests only from your website
const allowedOrigins = new Set([
  "https://royalsteel.in",
  "https://www.royalsteel.in"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );
  }

  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      return res.sendStatus(403);
    }
    return res.sendStatus(204);
  }

  if (origin && !allowedOrigins.has(origin)) {
    return res.sendStatus(403);
  }

  next();
});


// Secret keys must be configured in hosting environment variables
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

if (!keyId || !keySecret) {
  console.error("Razorpay environment variables are missing.");
}

const razorpay = new Razorpay({
  key_id: keyId,
  key_secret: keySecret
});

app.get("/", (req, res) => {
  res.json({
    service: "ROYALSTEEL Payment Backend",
    status: "running"
  });
});



const trustedProducts = {
  1: { name: "Butterfly Bed", price: 49999 },
  2: { name: "Royal Sofa", price: 7999 },
  3: { name: "King Chair", price: 3999 },
  4: { name: "Dining Table", price: 6999 }
};




// Create a Razorpay order

app.post("/create-order", async (req, res) => {
  try {
    const { items, receipt } = req.body || {};

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

    return res.json({
      success: true,
      key_id: keyId,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency
      }
    });
  } catch (error) {
    console.error(
      "Order creation failed:",
      error?.error?.description ||
      error?.description ||
      error?.message ||
      "Unknown error"
    );

    return res.status(500).json({
      success: false,
      message: "Could not create order"
    });
  }
});


    // IMPORTANT:
    // Before live sales, calculate the amount on the server
    // using your trusted product catalogue and cart.
    // Never trust a price supplied by the browser.

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt:
        typeof receipt === "string" &&
        /^[a-zA-Z0-9_-]{1,40}$/.test(receipt)
          ? receipt
          : `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
    });

    return res.json({
      success: true,
      key_id: keyId,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency
      }
    });
  } catch (error) {
console.error(
  "Order creation failed:",
  error?.error?.description ||
  error?.description ||
  error?.message ||
  JSON.stringify(error)
);
    return res.status(500).json({
      success: false,
      message: "Could not create order"
    });
  }
});

// Verify the Razorpay payment signature
app.post("/verify-payment", async (req, res) => {
  try {
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

    // Verify against the order created by Razorpay
    const order = await razorpay.orders.fetch(razorpay_order_id);

    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${order.id}|${razorpay_payment_id}`)
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

    // Also check the payment belongs to this order and is captured.
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
        message: "Payment is not captured or details do not match"
      });
    }

    return res.json({
      success: true,
      verified: true,
      message: "Payment verified successfully",
      payment_id: payment.id,
      order_id: order.id
    });
  } catch (error) {
    console.error("Payment verification failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not verify payment"
    });
  }
});

module.exports = app;
