// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const fetch = require("node-fetch");
const axios = require("axios");
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Razorpay instance (we'll use this in the order route shortly)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Simple health check route
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "TGP Razorpay backend is running" });
});
// Create Razorpay Order
app.post("/create-razorpay-order", async (req, res) => {
  try {
    const { amount, currency, receipt, notes } = req.body;

    // Basic validation
    if (!amount || !currency || !receipt) {
      return res.status(400).json({
        error: "Missing required fields: amount, currency, or receipt",
      });
    }

    // Ensure integer amount in paise
    const amountInt = parseInt(amount, 10);
    if (Number.isNaN(amountInt) || amountInt <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const options = {
      amount: amountInt,           // amount in paise
      currency: currency || "INR",
      receipt: receipt,
      notes: notes || {},         // e.g. plan_code, email, phone, gst_status, etc.
    };

    console.log("Creating Razorpay order with options:", options);

    const order = await razorpay.orders.create(options);

    console.log("Razorpay order created:", order.id);

    return res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      notes: order.notes,
    });
  } catch (err) {
    console.error("Error creating Razorpay order:", err);
    return res.status(500).json({
      error: "Failed to create order",
      details: err.message,
    });
  }
});

// ---------- Verify Razorpay Payment & Notify n8n ----------
app.post("/verify-payment", async (req, res) => {
  console.log(">>> /verify-payment HIT", req.body);   // 👈 ADD THIS LINE
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      // pass-through data from frontend:
      amount,
      currency,
      customer,
      plan,
      meta,
    } = req.body || {};

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({
        error: "Missing Razorpay payment verification fields",
      });
    }

    // 1) Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      console.error("Invalid Razorpay signature:", {
        razorpay_order_id,
        razorpay_payment_id,
      });
      return res.status(400).json({
        success: false,
        error: "Invalid signature",
      });
    }

    // 2) (Optional but recommended): fetch payment from Razorpay to confirm status
    let paymentDetails = null;
    try {
      paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (fetchErr) {
      console.error("Error fetching payment from Razorpay:", fetchErr.message);
    }

    // 3) Build payload for n8n / logging
    const payloadForN8N = {
      source: "TGP-AI-VIDEO-RAZORPAY",
      verified: true,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      amount,
      currency,
      customer: customer || {},
      plan: plan || {},
      meta: meta || {},
      payment_details: paymentDetails || {},
      verified_at: new Date().toISOString(),
    };

// 4) Send to n8n webhook (for Google Sheets / email / WhatsApp)
if (process.env.N8N_PAYMENT_WEBHOOK_URL) {
  try {
    console.log("👀 Calling n8n webhook:", process.env.N8N_PAYMENT_WEBHOOK_URL);
    console.log("📦 Payload for n8n:", JSON.stringify(payloadForN8N, null, 2));

    const response = await fetch(process.env.N8N_PAYMENT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadForN8N),
    });

    const text = await response.text();
    console.log("🔵 n8n webhook responded with:", text);
  } catch (webhookErr) {
    console.error("❌ Error calling N8N_PAYMENT_WEBHOOK_URL:", webhookErr);
  }
}


    return res.json({
      success: true,
      message: "Payment verified successfully",
    });
  } catch (err) {
    console.error("Error in /verify-payment:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: err.message,
    });
  }
});


// (We'll add /create-razorpay-order here in the next step)

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Razorpay backend listening on port ${PORT}`);
});