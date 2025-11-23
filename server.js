// server.js

// ---------------------------------------------------------------------
//  ENV + CORE IMPORTS
// ---------------------------------------------------------------------
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const fetch = require("node-fetch");
const axios = require("axios");

// ---------------------------------------------------------------------
//  ADMIN SECRET (TEMPORARY HARD-CODED FOR DEBUG)
// ---------------------------------------------------------------------
const ADMIN_OFFERS_SECRET = "VVAS_Offers_Admin_2025!";

console.log("[ADMIN] EXPECTED SECRET VALUE =", JSON.stringify(ADMIN_OFFERS_SECRET));

// Where offers will be stored (used by admin panel & public offer validation)
const OFFERS_FILE = path.join(__dirname, "offers.json");

// ---------------------------------------------------------------------
//  ADMIN AUTH MIDDLEWARE (OFFERS)
// ---------------------------------------------------------------------
function requireAdminSecret(req, res, next) {
  const headerSecret = req.headers["x-admin-secret"] || "";

  // Debug so we see exactly what the browser is sending
  console.log("[ADMIN] Incoming x-admin-secret =", JSON.stringify(headerSecret));

  if (!headerSecret) {
    return res
      .status(401)
      .json({ error: "Unauthorized: missing admin secret" });
  }

  if (headerSecret !== ADMIN_OFFERS_SECRET) {
    console.warn("[ADMIN] Invalid admin secret.");
    return res.status(401).json({ error: "Unauthorized: invalid admin secret" });
  }

  next();
}


// Where offers will be stored (used by admin panel & public offer validation)
const OFFERS_FILE = path.join(__dirname, "offers.json");

// ---------------------------------------------------------------------
//  ADMIN AUTH MIDDLEWARE (OFFERS)
// ---------------------------------------------------------------------
function requireAdminSecret(req, res, next) {
  const headerSecret = req.headers["x-admin-secret"];

  if (!headerSecret) {
    console.warn("[ADMIN] Missing x-admin-secret header.");
    return res.status(401).json({ error: "Unauthorized: missing admin secret" });
  }

  if (headerSecret !== ADMIN_OFFERS_SECRET) {
    console.warn("[ADMIN] Invalid x-admin-secret. Source:", ADMIN_OFFERS_SOURCE);
    return res.status(401).json({ error: "Unauthorized: invalid admin secret" });
  }

  next();
}

// ---------------------------------------------------------------------
//  EXPRESS APP + MIDDLEWARE
// ---------------------------------------------------------------------
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ---------------------------------------------------------------------
//  RAZORPAY INSTANCE
// ---------------------------------------------------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const N8N_ONETIME_WEBHOOK_URL = process.env.N8N_ONETIME_WEBHOOK_URL;

// ---------------------------------------------------------------------
//  OFFERS STORAGE HELPERS
// ---------------------------------------------------------------------

function loadOffers() {
  try {
    if (!fs.existsSync(OFFERS_FILE)) return [];
    const raw = fs.readFileSync(OFFERS_FILE, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];

    // Normalize to new schema (active/appliesTo/validity/etc.) as far as possible
    return arr.map((o) => {
      const offer = { ...o };

      // Backwards compat: enabled → active
      if (offer.active === undefined && typeof offer.enabled === "boolean") {
        offer.active = offer.enabled;
      }
      if (offer.active === undefined) {
        offer.active = true;
      }

      // Backwards compat: startAt / endAt → validity.{start,end}
      if (!offer.validity) {
        offer.validity = {
          start: offer.startAt || null,
          end: offer.endAt || null,
        };
      }

      // Backwards compat: applicablePlans → appliesTo.plans
      if (!offer.appliesTo) {
        offer.appliesTo = {
          plans: Array.isArray(offer.applicablePlans)
            ? offer.applicablePlans
            : [],
          billingTypes: Array.isArray(offer.billingTypes)
            ? offer.billingTypes
            : [],
          countries: Array.isArray(offer.countries) ? offer.countries : [],
        };
      } else {
        if (!Array.isArray(offer.appliesTo.plans)) {
          offer.appliesTo.plans = [];
        }
        if (!Array.isArray(offer.appliesTo.billingTypes)) {
          offer.appliesTo.billingTypes = [];
        }
        if (!Array.isArray(offer.appliesTo.countries)) {
          offer.appliesTo.countries = [];
        }
      }

      // Normalize type
      if (offer.type) {
        offer.type = String(offer.type).toUpperCase();
      }

      // Ensure amount is numeric
      if (offer.amount !== undefined) {
        offer.amount = Number(offer.amount);
      }

      // Defaults for usage tracking
      if (offer.usageLimit !== null && offer.usageLimit !== undefined) {
        offer.usageLimit = Number(offer.usageLimit);
      } else {
        offer.usageLimit = null;
      }

      if (offer.used === undefined) {
        offer.used = 0;
      } else {
        offer.used = Number(offer.used) || 0;
      }

      // Description fallback from notes
      if (!offer.description && offer.notes) {
        offer.description = offer.notes;
      }

      return offer;
    });
  } catch (err) {
    console.error("Error reading offers.json", err);
    return [];
  }
}

function saveOffers(offersArray) {
  try {
    fs.writeFileSync(
      OFFERS_FILE,
      JSON.stringify(offersArray, null, 2),
      "utf8"
    );
    console.log("offers.json updated. Total offers:", offersArray.length);
  } catch (err) {
    console.error("Error writing offers.json", err);
    throw err;
  }
}

// ---------------------------------------------------------------------
//  ONE-TIME PLAN PRICING + OFFER LOGIC
// ---------------------------------------------------------------------

// Base prices (INR, before GST) for ONE-TIME plans.
// Must match the planId values used in frontend + offers-admin.
const ONE_TIME_PLAN_PRICES = {
  PLAN_CALL: 5000, // 60-Minute Consultation
  PLAN_60: 40000,  // One-Time: Up to 60 Videos
  PLAN_90: 50000,  // One-Time: Up to 90 Videos
  PLAN_120: 55000, // One-Time: Up to 120 Videos
};

const STARTER_PRO_PLAN_PRICES = {
  SP_STARTER: 15000,
  SP_PRO: 30000,
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
//  ENTERPRISE PLAN PRICING HELPERS
// ---------------------------------------------------------------------

// Base monthly prices (INR, before GST) for ENTERPRISE plans.
const ENTERPRISE_BASE_PRICES = {
  "60": 40000,        // 60 videos / month
  "90": 50000,        // 90 videos / month
  "120": 55000,       // 120+ videos / month
  consultation: 5000, // Paid consultation call
};

// Compute enterprise base + GST + total
function computeEnterprisePrice(pkg, billingType, country) {
  const baseMonthly = ENTERPRISE_BASE_PRICES[pkg];
  if (!baseMonthly) {
    throw new Error("Invalid enterprise package");
  }

  let base = baseMonthly;
  const bt = (billingType || "subscription").toLowerCase();

  if (pkg === "consultation") {
    // Always one-time fee
    base = ENTERPRISE_BASE_PRICES.consultation;
  } else {
    if (bt === "yearly") {
      const yearlyBeforeDiscount = baseMonthly * 12;
      base = Math.round(yearlyBeforeDiscount * 0.8); // 20% off yearly
    } else {
      // "subscription" (monthly), "monthly", or "one_time" → 1x monthly amount
      base = baseMonthly;
    }
  }

  const isIndia = (country || "").trim().toLowerCase() === "india";
  const gst = isIndia ? Math.round(base * 0.18) : 0;
  const total = base + gst;

  return { base, gst, total };
}

// Build a planId for offers.json so coupons can target
// ENT_60_MONTHLY, ENT_60_YEARLY, ENT_60_ONE_TIME, ENT_CONSULTATION_ONE_TIME, etc.
function getEnterprisePlanId(pkg, billingType) {
  let baseId;
  if (pkg === "consultation") {
    baseId = "ENT_CONSULTATION";
  } else if (pkg === "60") {
    baseId = "ENT_60";
  } else if (pkg === "90") {
    baseId = "ENT_90";
  } else if (pkg === "120") {
    baseId = "ENT_120";
  } else {
    baseId = "ENT_UNKNOWN";
  }

  const bt = (billingType || "subscription").toUpperCase(); // SUBSCRIPTION | YEARLY | ONE_TIME
  return `${baseId}_${bt}`;
}

// ---------------------------------------------------------------------
//  OFFERS ADMIN – API (MATCHES NEW offers-admin.html)
// ---------------------------------------------------------------------

/**
 * New canonical shape of an offer in offers.json:
 * {
 *   code: "STARTER20",
 *   type: "PERCENT" | "FIXED",
 *   amount: 20,
 *   description: "Short note",
 *   active: true,
 *   appliesTo: {
 *     plans: ["SP_STARTER", "SP_PRO", "ENT_60_MONTHLY", ...],
 *     billingTypes: ["monthly", "yearly", "one_time"],
 *     countries: ["India", "United States"]
 *   },
 *   usageLimit: 50, // optional
 *   used: 0,        // optional
 *   validity: {
 *     start: "2025-11-20",
 *     end: "2025-12-01"
 *   }
 * }
 */

// GET /api/admin/plans  → used by offers-admin.html to show plan checkboxes & filters
app.get("/api/admin/plans", requireAdminSecret, (req, res) => {
  // These IDs must match the planId used in pricing + order creation
  const plans = [
    { id: "SP_STARTER", label: "Starter (Subscription / Monthly Base)" },
    { id: "SP_PRO", label: "Pro (Subscription / Monthly Base)" },

    { id: "ENT_60_MONTHLY", label: "Enterprise 60 – Monthly" },
    { id: "ENT_60_YEARLY", label: "Enterprise 60 – Yearly" },

    { id: "ENT_90_MONTHLY", label: "Enterprise 90 – Monthly" },
    { id: "ENT_90_YEARLY", label: "Enterprise 90 – Yearly" },

    { id: "ENT_120_MONTHLY", label: "Enterprise 120 – Monthly" },
    { id: "ENT_120_YEARLY", label: "Enterprise 120 – Yearly" },

    { id: "ENT_CONSULTATION_ONE_TIME", label: "Enterprise – Consultation (One-time)" },
  ];
  res.json(plans);
});

// GET /api/admin/offers  → list all offers
app.get("/api/admin/offers", requireAdminSecret, (req, res) => {
  try {
    const offers = loadOffers();
    return res.json(offers);
  } catch (err) {
    console.error("Error in GET /api/admin/offers:", err);
    return res.status(500).json({ error: "Failed to load offers" });
  }
});

// POST /api/admin/offers → create or upsert an offer (new schema)
app.post("/api/admin/offers", requireAdminSecret, (req, res) => {
  try {
    const {
      code,
      type,
      amount,
      description,
      active,
      appliesTo,
      usageLimit,
      validity,
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

    const plans =
      appliesTo && Array.isArray(appliesTo.plans)
        ? appliesTo.plans.map((p) => String(p || "").trim()).filter(Boolean)
        : [];
    const billingTypes =
      appliesTo && Array.isArray(appliesTo.billingTypes)
        ? appliesTo.billingTypes.map((b) => String(b || "").trim()).filter(Boolean)
        : [];
    const countries =
      appliesTo && Array.isArray(appliesTo.countries)
        ? appliesTo.countries.map((c) => String(c || "").trim()).filter(Boolean)
        : [];

    if (!plans.length) {
      return res.status(400).json({
        error: "At least one plan (appliesTo.plans) is required",
      });
    }

    const offers = loadOffers();
    const idx = offers.findIndex((o) => o.code === normalizedCode);

    const offerPayload = {
      code: normalizedCode,
      type: normalizedType,
      amount: numericAmount,
      description: description || "",
      active: active === false ? false : true,
      appliesTo: {
        plans,
        billingTypes,
        countries,
      },
      usageLimit:
        usageLimit === null || usageLimit === undefined
          ? null
          : Number(usageLimit),
      used: 0,
      validity: {
        start: validity && validity.start ? validity.start : null,
        end: validity && validity.end ? validity.end : null,
      },
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

// PATCH /api/admin/offers/:code/enable → mark offer as active
app.patch("/api/admin/offers/:code/enable", requireAdminSecret, (req, res) => {
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

    offers[idx].active = true;
    offers[idx].enabled = true; // keep legacy field in sync

    saveOffers(offers);
    return res.json({ success: true, offer: offers[idx] });
  } catch (err) {
    console.error("Error in PATCH /api/admin/offers/:code/enable:", err);
    return res.status(500).json({ error: "Failed to enable offer" });
  }
});

// PATCH /api/admin/offers/:code/disable → mark offer as inactive
app.patch("/api/admin/offers/:code/disable", requireAdminSecret, (req, res) => {
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

    offers[idx].active = false;
    offers[idx].enabled = false; // keep legacy field in sync

    saveOffers(offers);
    return res.json({ success: true, offer: offers[idx] });
  } catch (err) {
    console.error("Error in PATCH /api/admin/offers/:code/disable:", err);
    return res.status(500).json({ error: "Failed to disable offer" });
  }
});

// DELETE /api/admin/offers/:code → remove an offer
app.delete("/api/admin/offers/:code", requireAdminSecret, (req, res) => {
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

// (Optional legacy PATCH route kept for compatibility, but not used by new UI)
app.patch("/api/admin/offers/:code", requireAdminSecret, (req, res) => {
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
    const current = offers[idx];

    if (patch.type) {
      const t = String(patch.type).toUpperCase();
      if (["PERCENT", "FIXED"].includes(t)) {
        current.type = t;
      }
    }

    if (patch.amount !== undefined) {
      const amt = Number(patch.amount);
      if (amt > 0) {
        current.amount = amt;
      }
    }

    if (patch.active !== undefined) {
      current.active = !!patch.active;
      current.enabled = !!patch.active;
    }

    if (patch.description !== undefined) {
      current.description = patch.description || "";
    }

    if (patch.appliesTo) {
      const appliesTo = patch.appliesTo;
      if (Array.isArray(appliesTo.plans)) {
        current.appliesTo.plans = appliesTo.plans
          .map((p) => String(p || "").trim())
          .filter(Boolean);
      }
      if (Array.isArray(appliesTo.billingTypes)) {
        current.appliesTo.billingTypes = appliesTo.billingTypes
          .map((b) => String(b || "").trim())
          .filter(Boolean);
      }
      if (Array.isArray(appliesTo.countries)) {
        current.appliesTo.countries = appliesTo.countries
          .map((c) => String(c || "").trim())
          .filter(Boolean);
      }
    }

    if (patch.usageLimit !== undefined) {
      current.usageLimit =
        patch.usageLimit === null ? null : Number(patch.usageLimit);
    }

    if (patch.validity) {
      current.validity = {
        start:
          patch.validity.start !== undefined
            ? patch.validity.start
            : current.validity.start,
        end:
          patch.validity.end !== undefined
            ? patch.validity.end
            : current.validity.end,
      };
    }

    saveOffers(offers);
    return res.json({ success: true, offer: current });
  } catch (err) {
    console.error("Error in PATCH /api/admin/offers/:code:", err);
    return res.status(500).json({ error: "Failed to update offer" });
  }
});

// ---------------------------------------------------------------------
//  OFFER VALIDATION & APPLICATION (USED BY CHECKOUT)
// ---------------------------------------------------------------------

// Validate if a given couponCode is applicable to a planId
function validateOfferForPlan(planId, couponCode) {
  if (!couponCode) return { valid: false };

  const offers = loadOffers();
  if (!offers.length) return { valid: false };

  const now = new Date();
  const code = String(couponCode).trim().toUpperCase();

  const offer = offers.find((o) => (o.code || "").toUpperCase() === code);
  if (!offer) return { valid: false };

  // Active flag (supports both new 'active' and legacy 'enabled')
  const isActive =
    offer.active !== undefined
      ? !!offer.active
      : offer.enabled !== undefined
      ? !!offer.enabled
      : true;

  if (!isActive) return { valid: false };

  // Time window check (using validity.start/end or legacy startAt/endAt)
  let start = null;
  let end = null;

  if (offer.validity) {
    if (offer.validity.start) start = new Date(offer.validity.start);
    if (offer.validity.end) end = new Date(offer.validity.end);
  } else {
    if (offer.startAt) start = new Date(offer.startAt);
    if (offer.endAt) end = new Date(offer.endAt);
  }

  if (start && now < start) return { valid: false };
  if (end && now > end) return { valid: false };

  // Plan match check
  let plans = [];
  if (offer.appliesTo && Array.isArray(offer.appliesTo.plans)) {
    plans = offer.appliesTo.plans;
  } else if (Array.isArray(offer.applicablePlans)) {
    plans = offer.applicablePlans;
  }

  if (plans.length > 0 && !plans.includes(planId)) {
    return { valid: false };
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
//  CREATE RAZORPAY ORDER FOR ONE-TIME PAYMENT (RETIRED ENDPOINT)
// ---------------------------------------------------------------------

app.post("/create-onetime-order", (req, res) => {
  console.warn(
    "[DEPRECATED] /create-onetime-order was called. " +
      "This endpoint is retired; use /api/create-enterprise-order instead."
  );

  return res.status(410).json({
    success: false,
    message:
      "This one-time checkout endpoint has been retired. " +
      "Please use the Enterprise checkout flow instead.",
  });
});

// ---------------------------------------------------------------------
//  ENTERPRISE: CREATE RAZORPAY ORDER (60 / 90 / 120 / consultation)
// ---------------------------------------------------------------------

app.post("/api/create-enterprise-order", async (req, res) => {
  try {
    const {
      fullName,
      email,
      mobileCountryCode,
      mobileNumber,
      phoneCountryCode,
      phoneNumber,
      waCountryCode,
      waNumber,
      company,
      gstStatus,
      gstNumber,
      country,
      city,
      state,
      postalCode,
      package: pkg,
      billingType,
      isConsultation,
      coupon,
    } = req.body || {};

    if (!fullName || !email || !pkg) {
      return res.status(400).json({
        success: false,
        error: "fullName, email and package are required",
      });
    }

    if (!mobileCountryCode || !mobileNumber) {
      console.warn("Enterprise order without primary mobile:", {
        fullName,
        email,
      });
    }

    if (gstStatus === "yes" && !company) {
      return res.status(400).json({
        success: false,
        error: "Company / Brand name is required when registered with GST.",
      });
    }

    const pkgValue = pkg === "consultation" ? "consultation" : String(pkg);
    let billingTypeValue = (billingType || "subscription").toLowerCase();

    if (billingTypeValue === "subscription") {
      billingTypeValue = "monthly";
    }

    const consultation = pkgValue === "consultation" || Boolean(isConsultation);
    if (consultation) {
      billingTypeValue = "one_time";
    }

    const { base, gst, total } = computeEnterprisePrice(
      pkgValue,
      billingTypeValue,
      country
    );

    const planId = getEnterprisePlanId(pkgValue, billingTypeValue);

    const result = validateOfferForPlan(planId, coupon);
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

    const amountInPaise = Math.round(finalAmount * 100);

    const receiptId =
      "VVAS_ENT_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 7);

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: receiptId,
      notes: {
        product: "VVAS",
        segment: "enterprise",
        planId,
        enterprisePackage: pkgValue,
        billingType: billingTypeValue,
        isConsultation: consultation ? "yes" : "no",
        fullName,
        email,
        mobile: `${mobileCountryCode || ""}${mobileNumber || ""}`,
        phone: `${phoneCountryCode || ""}${phoneNumber || ""}`,
        whatsapp: `${waCountryCode || ""}${waNumber || ""}`,
        company: company || "",
        gstStatus: gstStatus || "",
        gstNumber: gstNumber || "",
        country: country || "",
        city: city || "",
        state: state || "",
        postalCode: postalCode || "",
        basePrice: String(base),
        gstAmount: String(gst),
        grossTotal: String(total),
        discount: String(discount),
        finalAmount: String(finalAmount),
        couponCode: coupon || "",
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
      planId,
      pricing: {
        base,
        gst,
        total,
        discount,
        final: finalAmount,
      },
      offerApplied: !!offerMeta,
      offer: offerMeta,
      description: consultation
        ? "VVAS – Paid consultation call (enterprise)"
        : `VVAS Enterprise – ${pkgValue} videos / month (${billingTypeValue})`,
    });
  } catch (err) {
    console.error("Error in /api/create-enterprise-order:", err);
    return res.status(500).json({
      success: false,
      error: "Server error creating enterprise order.",
      details: err.message,
    });
  }
});

// ---------------------------------------------------------------------
//  STARTER/PRO: CREATE RAZORPAY ORDER (with offers.json)
// ---------------------------------------------------------------------

app.post("/api/create-starterpro-order", async (req, res) => {
  try {
    const { plan, billingType, country, coupon } = req.body || {};

    if (!plan) {
      return res.status(400).json({
        success: false,
        error: "plan is required",
      });
    }

    const planNormalized = plan === "pro" ? "pro" : "starter";
    const planId = planNormalized === "starter" ? "SP_STARTER" : "SP_PRO";

    let base = STARTER_PRO_PLAN_PRICES[planId];
    if (!base) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan",
      });
    }

    let bt = (billingType || "monthly").toLowerCase();
    if (bt === "subscription") bt = "monthly";

    if (bt === "yearly") {
      const yearlyBeforeDiscount = base * 12;
      base = Math.round(yearlyBeforeDiscount * 0.8); // 20% discount
    } else {
      base = base;
    }

    const isIndia = (country || "").trim().toLowerCase() === "india";
    const gst = isIndia ? Math.round(base * 0.18) : 0;
    const total = base + gst;

    const result = validateOfferForPlan(planId, coupon);
    let finalAmount = total;
    let discount = 0;
    let offerDescription = null;
    let offerMeta = null;

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

    const amountInPaise = Math.round(finalAmount * 100);
    const receiptId =
      "VVAS_SP_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 7);

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: receiptId,
      notes: {
        product: "VVAS",
        segment: "starterpro",
        planId,
        plan: planNormalized,
        billingType: bt,
        country: country || "",
        basePrice: String(base),
        gstAmount: String(gst),
        grossTotal: String(total),
        discount: String(discount),
        finalAmount: String(finalAmount),
        couponCode: coupon || "",
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
      planId,
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
    console.error("Error in /api/create-starterpro-order:", err);
    return res.status(500).json({
      success: false,
      error: "Server error creating starter/pro order.",
      details: err.message,
    });
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

    let paymentDetails = null;
    try {
      paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (fetchErr) {
      console.error("Error fetching payment from Razorpay:", fetchErr.message);
    }

    let orderDetails = null;
    try {
      orderDetails = await razorpay.orders.fetch(razorpay_order_id);
    } catch (orderErr) {
      console.error("Error fetching order from Razorpay:", orderErr.message);
    }

    const orderNotes =
      orderDetails && orderDetails.notes ? orderDetails.notes : {};

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
      meta: {
        ...(meta || {}),
        razorpay_order_notes: orderNotes,
      },
      payment_details: paymentDetails || {},
      order_details: orderDetails || {},
      verified_at: new Date().toISOString(),
    };

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
//  VERIFY ONE-TIME PAYMENT (RETIRED ENDPOINT)
// ---------------------------------------------------------------------

app.post("/verify-onetime-payment", (req, res) => {
  console.warn(
    "[DEPRECATED] /verify-onetime-payment was called. " +
      "This endpoint is retired; one-time verification is now handled by /verify-payment."
  );

  return res.status(410).json({
    success: false,
    message:
      "This one-time payment verification endpoint has been retired. " +
      "Use the standard /verify-payment flow instead.",
  });
});

// ---------------------------------------------------------------------
//  START SERVER
// ---------------------------------------------------------------------

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Razorpay backend listening on port ${PORT}`);
});
