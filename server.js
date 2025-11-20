// server.js

const fs = require("fs");
const path = require("path");

const ADMIN_OFFERS_SECRET = process.env.ADMIN_OFFERS_SECRET || "change-me-in-env";

// ---------------------------------------------------------------------
//  ADMIN AUTH MIDDLEWARE (OFFERS)
// ---------------------------------------------------------------------
function requireAdminSecret(req, res, next) {
  const headerSecret = req.headers["x-admin-secret"];

  if (!headerSecret || headerSecret !== ADMIN_OFFERS_SECRET) {
    console.warn("Admin auth failed for /api/admin/offers");
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// Where offers will be stored (used by admin panel & public offer validation)
const OFFERS_FILE = path.join(__dirname, "offers.json");

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const fetch = require("node-fetch");
const axios = require("axios");
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const N8N_ONETIME_WEBHOOK_URL = process.env.N8N_ONETIME_WEBHOOK_URL;

// ---------------------------------------------------------------------
//  OFFERS STORAGE (READ-ONLY HERE; ADMIN PANEL WRITES THIS FILE)
// ---------------------------------------------------------------------

function loadOffers() {
  try {
    if (!fs.existsSync(OFFERS_FILE)) return [];
    const raw = fs.readFileSync(OFFERS_FILE, "utf8");
    if (!raw.trim()) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading offers.json", err);
    return [];
  }
}

// ---------------------------------------------------------------------
//  ONE-TIME PLAN PRICING + OFFER LOGIC
// ---------------------------------------------------------------------

// Base prices (INR, before GST) for ONE-TIME plans.
// Must match the planId values used in frontend + offers-admin.
const ONE_TIME_PLAN_PRICES = {
  PLAN_CALL: 5000,   // 60-Minute Consultation
  PLAN_60: 40000,    // One-Time: Up to 60 Videos
  PLAN_90: 50000,    // One-Time: Up to 90 Videos
  PLAN_120: 55000,   // One-Time: Up to 120 Videos
};

// Compute base + GST + total for a one-time plan
function computeOneTimePrice(planId, customBasePrice) {
  let base = ONE_TIME_PLAN_PRICES[planId] ?? 0;

  // Allow override from frontend for custom deals
  if (typeof customBasePrice === "number" && customBasePrice > 0) {
    base = customBasePrice;
  }

  const gst = Math.round(base * 0.18); // 18% GST
  const total = base + gst;

  return { base, gst, total };
}

// ---------------------------------------------------------------------
//  OFFERS ADMIN – READ / WRITE offers.json
// ---------------------------------------------------------------------

function saveOffers(offersArray) {
  try {
    fs.writeFileSync(OFFERS_FILE, JSON.stringify(offersArray, null, 2), "utf8");
    console.log("offers.json updated. Total offers:", offersArray.length);
  } catch (err) {
    console.error("Error writing offers.json", err);
    throw err;
  }
}

/**
 * Shape of an offer in offers.json:
 * {
 *   code: "DIWALI20",
 *   type: "PERCENT" | "FIXED",
 *   amount: 20,                    // percent or INR
 *   enabled: true,
 *   startAt: "2025-11-20T00:00:00.000Z" | null,
 *   endAt: "2025-12-01T00:00:00.000Z" | null,
 *   applicablePlans: ["PLAN_60", "PLAN_90"],
 *   notes: "Intro offer for one-time plans"
 * }
 */

// GET /api/admin/offers  → list all offers
app.get("/api/admin/offers", (req, res) => {
  try {
    const offers = loadOffers();
    return res.json(offers);
  } catch (err) {
    console.error("Error in GET /api/admin/offers:", err);
    return res.status(500).json({ error: "Failed to load offers" });
  }
});

// POST /api/admin/offers → create or upsert an offer
app.post("/api/admin/offers", (req, res) => {
  try {
    const {
      code,
      type,
      amount,
      enabled,
      startAt,
      endAt,
      applicablePlans,
      notes,
    } = req.body || {};

    if (!code || !type || !amount) {
      return res.status(400).json({
        error: "code, type and amount are required",
      });
    }

    const normalizedCode = String(code).trim().toUpperCase();
    const normalizedType = String(type).trim().toUpperCase(); // PERCENT | FIXED
    const numericAmount = Number(amount);

    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: "amount must be > 0" });
    }
    if (!["PERCENT", "FIXED"].includes(normalizedType)) {
      return res.status(400).json({ error: "type must be PERCENT or FIXED" });
    }

    let plans = Array.isArray(applicablePlans) ? applicablePlans : [];
    plans = plans
      .map((p) => String(p || "").trim())
      .filter(Boolean);

    if (!plans.length) {
      return res.status(400).json({
        error: "At least one applicablePlans value is required",
      });
    }

    const offers = loadOffers();
    const idx = offers.findIndex((o) => o.code === normalizedCode);

    const offerPayload = {
      code: normalizedCode,
      type: normalizedType,
      amount: numericAmount,
      enabled: enabled === false ? false : true,
      startAt: startAt || null,
      endAt: endAt || null,
      applicablePlans: plans,
      notes: notes || "",
    };

    if (idx >= 0) {
      // update existing
      offers[idx] = {
        ...offers[idx],
        ...offerPayload,
      };
      console.log("Updated offer:", normalizedCode);
    } else {
      // create new
      offers.push(offerPayload);
      console.log("Created new offer:", normalizedCode);
    }

    saveOffers(offers);
    return res.json({ success: true, offer: offerPayload });
  } catch (err) {
    console.error("Error in POST /api/admin/offers:", err);
    return res.status(500).json({ error: "Failed to save offer" });
  }
});

// PATCH /api/admin/offers/:code → partial update (used mainly for enable/disable)
app.patch("/api/admin/offers/:code", (req, res) => {
  try {
    const codeParam = (req.params.code || "").toUpperCase();
    if (!codeParam) {
      return res.status(400).json({ error: "Offer code is required in URL" });
    }

    const offers = loadOffers();
    const idx = offers.findIndex((o) => o.code === codeParam);

    if (idx < 0) {
      return res.status(404).json({ error: "Offer not found" });
    }

    const patch = req.body || {};

    if (patch.type) {
      const t = String(patch.type).toUpperCase();
      if (["PERCENT", "FIXED"].includes(t)) {
        offers[idx].type = t;
      }
    }

    if (patch.amount !== undefined) {
      const amt = Number(patch.amount);
      if (amt > 0) {
        offers[idx].amount = amt;
      }
    }

    if (patch.enabled !== undefined) {
      offers[idx].enabled = !!patch.enabled;
    }

    if (patch.startAt !== undefined) {
      offers[idx].startAt = patch.startAt || null;
    }
    if (patch.endAt !== undefined) {
      offers[idx].endAt = patch.endAt || null;
    }

    if (patch.applicablePlans) {
      let plans = Array.isArray(patch.applicablePlans)
        ? patch.applicablePlans
        : [];
      plans = plans
        .map((p) => String(p || "").trim())
        .filter(Boolean);
      if (plans.length) {
        offers[idx].applicablePlans = plans;
      }
    }

    if (patch.notes !== undefined) {
      offers[idx].notes = patch.notes || "";
    }

    saveOffers(offers);
    return res.json({ success: true, offer: offers[idx] });
  } catch (err) {
    console.error("Error in PATCH /api/admin/offers/:code:", err);
    return res.status(500).json({ error: "Failed to update offer" });
  }
});

// DELETE /api/admin/offers/:code → remove an offer
app.delete("/api/admin/offers/:code", (req, res) => {
  try {
    const codeParam = (req.params.code || "").toUpperCase();
    if (!codeParam) {
      return res.status(400).json({ error: "Offer code is required in URL" });
    }

    const offers = loadOffers();
    const beforeCount = offers.length;
    const filtered = offers.filter((o) => o.code !== codeParam);

    if (filtered.length === beforeCount) {
      return res.status(404).json({ error: "Offer not found" });
    }

    saveOffers(filtered);
    console.log("Deleted offer:", codeParam);
    return res.json({ success: true });
  } catch (err) {
    console.error("Error in DELETE /api/admin/offers/:code:", err);
    return res.status(500).json({ error: "Failed to delete offer" });
  }
});

// Validate if a given couponCode is applicable to a planId
function validateOfferForPlan(planId, couponCode) {
  if (!couponCode) return { valid: false };

  const offers = loadOffers();
  if (!offers.length) return { valid: false };

  const now = new Date();
  const code = String(couponCode).trim().toUpperCase();

  const offer = offers.find((o) => o.code === code);
  if (!offer) return { valid: false };

  if (!offer.enabled) return { valid: false };

  // Time window check
  if (offer.startAt) {
    const start = new Date(offer.startAt);
    if (now < start) {
      return { valid: false };
    }
  }
  if (offer.endAt) {
    const end = new Date(offer.endAt);
    if (now > end) {
      return { valid: false };
    }
  }

  // Plan match check
  if (Array.isArray(offer.applicablePlans) && offer.applicablePlans.length > 0) {
    if (!offer.applicablePlans.includes(planId)) {
      return { valid: false };
    }
  }

  return {
    valid: true,
    offer,
  };
}

// Apply offer to a total amount, and return discount + final
function applyOffer(totalAmount, offer) {
  if (!offer) {
    return {
      discount: 0,
      final: totalAmount,
      description: null,
    };
  }

  let discount = 0;
  if (offer.type === "PERCENT") {
    discount = Math.round((totalAmount * Number(offer.amount || 0)) / 100);
  } else if (offer.type === "FIXED") {
    discount = Math.round(Number(offer.amount || 0));
  }

  if (discount < 0) discount = 0;
  if (discount > totalAmount) discount = totalAmount;

  const final = totalAmount - discount;

  const description =
    offer.type === "PERCENT"
      ? `${offer.amount}% off via ${offer.code}`
      : `₹${offer.amount} off via ${offer.code}`;

  return {
    discount,
    final,
    description,
  };
}

// ---------------------------------------------------------------------
//  SIMPLE HEALTH CHECK
// ---------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "TGP Razorpay backend is running" });
});

// ---------------------------------------------------------------------
//  GENERIC CREATE RAZORPAY ORDER (ALREADY USED BY YOUR FRONTEND)
// ---------------------------------------------------------------------

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
      amount: amountInt, // amount in paise
      currency: currency || "INR",
      receipt: receipt,
      notes: notes || {}, // e.g. plan_code, email, phone, gst_status, etc.
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

// ---------------------------------------------------------------------
//  PUBLIC: VALIDATE OFFER FOR ONE-TIME PLAN (for checkout UI)
// ---------------------------------------------------------------------

app.post("/api/validate-offer", (req, res) => {
  try {
    const { planId, basePrice, couponCode } = req.body;

    if (!planId) {
      return res.status(400).json({ error: "planId is required" });
    }

    const customBasePrice = basePrice ? Number(basePrice) : undefined;
    const { base, gst, total } = computeOneTimePrice(planId, customBasePrice);

    const result = validateOfferForPlan(planId, couponCode);
    if (!result.valid) {
      return res.json({
        success: true,
        planId,
        base,
        gst,
        total,
        offerApplied: false,
        final: total,
      });
    }

    const { discount, final, description } = applyOffer(total, result.offer);

    res.json({
      success: true,
      planId,
      base,
      gst,
      total,
      offerApplied: true,
      offerCode: result.offer.code,
      offerType: result.offer.type,
      offerAmount: result.offer.amount,
      discount,
      final,
      offerDescription: description,
    });
  } catch (err) {
    console.error("Error in /api/validate-offer", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------
//  CREATE RAZORPAY ORDER FOR ONE-TIME PAYMENT (with offers)
// ---------------------------------------------------------------------

app.post("/create-onetime-order", async (req, res) => {
  try {
    const {
      planId,
      customBasePrice, // optional override
      couponCode,
      fullName,
      companyName,
      email,
      phone,
      whatsapp,
      gstNumber,
      registeredWithGst,
    } = req.body;

    if (!planId || !fullName || !email) {
      return res
        .status(400)
        .json({ error: "planId, fullName and email are required" });
    }

    const basePriceNum =
      typeof customBasePrice === "number" ? customBasePrice : undefined;
    const { base, gst, total } = computeOneTimePrice(planId, basePriceNum);

    // Validate / apply offer
    const result = validateOfferForPlan(planId, couponCode);
    let offerMeta = null;
    let finalAmount = total;
    let discount = 0;
    let offerDescription = null;

    if (result.valid) {
      const calc = applyOffer(total, result.offer);
      finalAmount = calc.final;
      discount = calc.discount;
      offerDescription = calc.description;
      offerMeta = {
        code: result.offer.code,
        type: result.offer.type,
        amount: result.offer.amount,
      };
    }

    const amountInPaise = finalAmount * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `VVAS_ONETIME_${Date.now()}`,
      notes: {
        planId,
        fullName,
        companyName: companyName || "",
        email,
        phone: phone || "",
        whatsapp: whatsapp || "",
        gstNumber: gstNumber || "",
        registeredWithGst: registeredWithGst ? "yes" : "no",
        basePrice: String(base),
        gstAmount: String(gst),
        grossTotal: String(total),
        discount: String(discount),
        finalAmount: String(finalAmount),
        couponCode: couponCode || "",
        offerDescription: offerDescription || "",
      },
    });

    return res.json({
      success: true,
      razorpayKey: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: finalAmount,
      amountInPaise,
      currency: order.currency,
      pricing: {
        base,
        gst,
        total,
        discount,
        final: finalAmount,
      },
      offerApplied: !!offerMeta,
      offer: offerMeta,
    });
  } catch (err) {
    console.error("Error in /create-onetime-order", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------
//  VERIFY RAZORPAY PAYMENT (EXISTING) → n8n for subscriptions / generic
// ---------------------------------------------------------------------

app.post("/verify-payment", async (req, res) => {
  console.log(">>> /verify-payment HIT", req.body);
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

// ---------------------------------------------------------------------
//  VERIFY ONE-TIME PAYMENT → n8n (SEPARATE WORKFLOW)
// ---------------------------------------------------------------------

app.post("/verify-onetime-payment", async (req, res) => {
  console.log(">>> /verify-onetime-payment HIT", req.body);

  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      planId,
      amount,
      currency,
      customer, // { fullName, email, phone, whatsapp, companyName, gstNumber, registeredWithGst }
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
      console.error("Invalid Razorpay signature (one-time):", {
        razorpay_order_id,
        razorpay_payment_id,
      });
      return res.status(400).json({
        success: false,
        error: "Invalid signature",
      });
    }

    // 2) Optional: fetch payment details from Razorpay
    let paymentDetails = null;
    try {
      paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (fetchErr) {
      console.error(
        "Error fetching payment from Razorpay (one-time):",
        fetchErr.message
      );
    }

    const payloadForN8N = {
      source: "TGP-AI-VIDEO-RAZORPAY-ONETIME",
      verified: true,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      planId,
      amount,
      currency,
      customer: customer || {},
      meta: meta || {},
      payment_details: paymentDetails || {},
      verified_at: new Date().toISOString(),
    };

    if (N8N_ONETIME_WEBHOOK_URL) {
      try {
        console.log("👀 Calling one-time n8n webhook:", N8N_ONETIME_WEBHOOK_URL);
        console.log("📦 One-time payload for n8n:", JSON.stringify(payloadForN8N, null, 2));

        const response = await fetch(N8N_ONETIME_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadForN8N),
        });

        const text = await response.text();
        console.log("🔵 One-time n8n webhook responded with:", text);
      } catch (webhookErr) {
        console.error("❌ Error calling N8N_ONETIME_WEBHOOK_URL:", webhookErr);
      }
    }

    return res.json({
      success: true,
      message: "One-time payment verified successfully",
    });
  } catch (err) {
    console.error("Error in /verify-onetime-payment:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: err.message,
    });
  }
});

// ---------------------------------------------------------------------
//  START SERVER
// ---------------------------------------------------------------------

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Razorpay backend listening on port ${PORT}`);
});
