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
//  ADMIN SECRET
// ---------------------------------------------------------------------
const ADMIN_OFFERS_SECRET = process.env.ADMIN_OFFERS_SECRET;

console.log("[ADMIN] EXPECTED SECRET VALUE =", JSON.stringify(ADMIN_OFFERS_SECRET));

// Where offers will be stored (used by admin panel & public offer validation)
const OFFERS_FILE = path.join(__dirname, "offers.json");

// ---------------------------------------------------------------------
//  ADMIN AUTH MIDDLEWARE (OFFERS)
// ---------------------------------------------------------------------
function requireAdminSecret(req, res, next) {
  const headerSecret = req.headers["x-admin-secret"] || "";

  console.log("[ADMIN] Incoming x-admin-secret =", JSON.stringify(headerSecret));

  if (!headerSecret) {
    return res
      .status(401)
      .json({ error: "Unauthorized: missing admin secret" });
  }

  if (headerSecret !== ADMIN_OFFERS_SECRET) {
    console.warn("[ADMIN] Invalid admin secret.");
    return res
      .status(401)
      .json({ error: "Unauthorized: invalid admin secret" });
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
//  THANK-YOU SIGNATURE HELPERS (v1)
// ---------------------------------------------------------------------
const THANKYOU_SIG_SECRET = process.env.THANKYOU_SIG_SECRET;

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signThankYouV1({ order_id, payment_id, ts }) {
  if (!THANKYOU_SIG_SECRET) {
    throw new Error("THANKYOU_SIG_SECRET not configured");
  }

  const canonical = `v1|order_id=${order_id}|payment_id=${payment_id}|ts=${ts}`;
  const mac = crypto
    .createHmac("sha256", THANKYOU_SIG_SECRET)
    .update(canonical)
    .digest();

  return base64url(mac);
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

// ---------------------------------------------------------------------
//  THANK-YOU CONTRACT STORE (v1) — in-memory with TTL
//  (v1 rollout: fast + simple; swap to DB later if needed)
// ---------------------------------------------------------------------
const THANKYOU_CONTRACT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const thankYouContractStore = new Map(); // key -> { storedAt, contract }

function makeThankYouKey({ order_id, payment_id }) {
  return `v1|order_id=${order_id}|payment_id=${payment_id}`;
}

function purgeThankYouContracts() {
  const now = Date.now();
  for (const [k, v] of thankYouContractStore.entries()) {
    if (!v?.storedAt || now - v.storedAt > THANKYOU_CONTRACT_TTL_MS) {
      thankYouContractStore.delete(k);
    }
  }
}

function storeThankYouContract({ order_id, payment_id, contract }) {
  purgeThankYouContracts();
  const key = makeThankYouKey({ order_id, payment_id });
  thankYouContractStore.set(key, { storedAt: Date.now(), contract });
}

function getThankYouContract({ order_id, payment_id }) {
  purgeThankYouContracts();
  const key = makeThankYouKey({ order_id, payment_id });
  const found = thankYouContractStore.get(key);
  return found?.contract || null;
}

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

    return arr.map((o) => {
      const offer = { ...o };

      if (offer.active === undefined && typeof offer.enabled === "boolean") {
        offer.active = offer.enabled;
      }
      if (offer.active === undefined) {
        offer.active = true;
      }

      if (!offer.validity) {
        offer.validity = {
          start: offer.startAt || null,
          end: offer.endAt || null,
        };
      }

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
        if (!Array.isArray(offer.appliesTo.plans)) offer.appliesTo.plans = [];
        if (!Array.isArray(offer.appliesTo.billingTypes)) offer.appliesTo.billingTypes = [];
        if (!Array.isArray(offer.appliesTo.countries)) offer.appliesTo.countries = [];
      }

      if (offer.type) offer.type = String(offer.type).toUpperCase();

      if (offer.amount !== undefined) offer.amount = Number(offer.amount);

      if (offer.usageLimit !== null && offer.usageLimit !== undefined) {
        offer.usageLimit = Number(offer.usageLimit);
      } else {
        offer.usageLimit = null;
      }

      if (offer.used === undefined) offer.used = 0;
      else offer.used = Number(offer.used) || 0;

      if (!offer.description && offer.notes) offer.description = offer.notes;

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
const ONE_TIME_PLAN_PRICES = {
  PLAN_CALL: 5000,
  PLAN_60: 40000,
  PLAN_90: 50000,
  PLAN_120: 55000,
};

const STARTER_PRO_PLAN_PRICES = {
  SP_STARTER: 15000,
  SP_PRO: 30000,
};

function computeOneTimePrice(planId, customBasePrice) {
  let base = ONE_TIME_PLAN_PRICES[planId] ?? 0;
  if (typeof customBasePrice === "number" && customBasePrice > 0) {
    base = customBasePrice;
  }
  const gst = Math.round(base * 0.18);
  const total = base + gst;
  return { base, gst, total };
}

// ---------------------------------------------------------------------
//  ENTERPRISE PLAN PRICING HELPERS
// ---------------------------------------------------------------------
const ENTERPRISE_BASE_PRICES = {
  "60": 40000,
  "90": 50000,
  "120": 55000,
  consultation: 5000,
};

function computeEnterprisePrice(pkg, billingType, country) {
  const baseMonthly = ENTERPRISE_BASE_PRICES[pkg];
  if (!baseMonthly) throw new Error("Invalid enterprise package");

  let base = baseMonthly;
  const bt = (billingType || "monthly").toLowerCase();

  if (pkg === "consultation") {
    base = ENTERPRISE_BASE_PRICES.consultation;
  } else {
    if (bt === "yearly") {
      const yearlyBeforeDiscount = baseMonthly * 12;
      base = Math.round(yearlyBeforeDiscount * 0.8);
    } else {
      base = baseMonthly;
    }
  }

  const isIndia = (country || "").trim().toLowerCase() === "india";
  const gst = isIndia ? Math.round(base * 0.18) : 0;
  const total = base + gst;

  return { base, gst, total };
}

function getEnterprisePlanId(pkg, billingType) {
  if (pkg === "consultation") return "ENT_CONSULTATION";
  if (pkg === "60") return "ENT_60";
  if (pkg === "90") return "ENT_90";
  if (pkg === "120") return "ENT_120";
  return "ENT_UNKNOWN";
}

// ---------------------------------------------------------------------
//  CANONICAL PLAN LIST (for Offers Engine + /api/admin/plans)
// ---------------------------------------------------------------------
const PLANS_CONFIG = [
  { id: "SP_STARTER", label: "Starter", allowedBilling: ["monthly", "yearly"], isConsultation: false },
  { id: "SP_PRO", label: "Pro", allowedBilling: ["monthly", "yearly"], isConsultation: false },
  { id: "ENT_60", label: "Enterprise 60", allowedBilling: ["monthly", "yearly"], isConsultation: false },
  { id: "ENT_90", label: "Enterprise 90", allowedBilling: ["monthly", "yearly"], isConsultation: false },
  { id: "ENT_120", label: "Enterprise 120", allowedBilling: ["monthly", "yearly"], isConsultation: false },
  { id: "ENT_CONSULTATION", label: "Consultation (One-time)", allowedBilling: ["one_time"], isConsultation: true },
];

function deriveBillingTypesFromPlans(planIds = []) {
  const uniqueIds = Array.from(new Set(planIds || []));
  const selectedPlans = uniqueIds
    .map((id) => PLANS_CONFIG.find((p) => p.id === id))
    .filter(Boolean);

  if (!selectedPlans.length) return [];

  const hasConsultation = selectedPlans.some((p) => p.isConsultation);
  if (hasConsultation) return ["one_time"];

  const set = new Set();
  selectedPlans.forEach((p) => (p.allowedBilling || []).forEach((bt) => set.add(bt)));
  return Array.from(set);
}

// ---------------------------------------------------------------------
//  OFFERS ADMIN – API
// ---------------------------------------------------------------------
app.get("/api/admin/plans", requireAdminSecret, (req, res) => {
  try {
    const payload = PLANS_CONFIG.map((p) => ({
      id: p.id,
      label: p.label,
      allowedBilling: p.allowedBilling || [],
      isConsultation: !!p.isConsultation,
    }));
    return res.json(payload);
  } catch (err) {
    console.error("Error in GET /api/admin/plans:", err);
    return res.status(500).json({ error: "Failed to load plans" });
  }
});

app.get("/api/admin/offers", requireAdminSecret, (req, res) => {
  try {
    const offers = loadOffers();
    return res.json(offers);
  } catch (err) {
    console.error("Error in GET /api/admin/offers:", err);
    return res.status(500).json({ error: "Failed to load offers" });
  }
});

app.post("/api/admin/offers", requireAdminSecret, (req, res) => {
  try {
    const { code, type, amount, description, active, appliesTo, usageLimit, validity } = req.body || {};

    if (!code || !type || !amount) {
      return res.status(400).json({ error: "code, type and amount are required" });
    }

    const normalizedCode = String(code).trim().toUpperCase();
    const normalizedType = String(type).trim().toUpperCase();
    const numericAmount = Number(amount);

    if (!numericAmount || numericAmount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    if (!["PERCENT", "FIXED"].includes(normalizedType)) return res.status(400).json({ error: "type must be PERCENT or FIXED" });

    const plans =
      appliesTo && Array.isArray(appliesTo.plans)
        ? appliesTo.plans.map((p) => String(p || "").trim()).filter(Boolean)
        : [];

    const billingTypes = deriveBillingTypesFromPlans(plans);

    const countries =
      appliesTo && Array.isArray(appliesTo.countries)
        ? appliesTo.countries.map((c) => String(c || "").trim()).filter(Boolean)
        : [];

    if (!plans.length) {
      return res.status(400).json({ error: "At least one plan (appliesTo.plans) is required" });
    }

    const offers = loadOffers();
    const idx = offers.findIndex((o) => o.code === normalizedCode);

    const offerPayload = {
      code: normalizedCode,
      type: normalizedType,
      amount: numericAmount,
      description: description || "",
      active: active === false ? false : true,
      appliesTo: { plans, billingTypes, countries },
      usageLimit: usageLimit === null || usageLimit === undefined ? null : Number(usageLimit),
      used: 0,
      validity: {
        start: validity && validity.start ? validity.start : null,
        end: validity && validity.end ? validity.end : null,
      },
    };

    if (idx >= 0) offers[idx] = { ...offers[idx], ...offerPayload };
    else offers.push(offerPayload);

    saveOffers(offers);
    return res.json({ success: true, offer: offerPayload });
  } catch (err) {
    console.error("Error in POST /api/admin/offers:", err);
    return res.status(500).json({ error: "Failed to save offer" });
  }
});

app.patch("/api/admin/offers/:code/enable", requireAdminSecret, (req, res) => {
  try {
    const codeParam = (req.params.code || "").toUpperCase();
    if (!codeParam) return res.status(400).json({ error: "Offer code is required in URL" });

    const offers = loadOffers();
    const idx = offers.findIndex((o) => o.code === codeParam);
    if (idx < 0) return res.status(404).json({ error: "Offer not found" });

    offers[idx].active = true;
    offers[idx].enabled = true;

    saveOffers(offers);
    return res.json({ success: true, offer: offers[idx] });
  } catch (err) {
    console.error("Error in PATCH /api/admin/offers/:code/enable:", err);
    return res.status(500).json({ error: "Failed to enable offer" });
  }
});

app.patch("/api/admin/offers/:code/disable", requireAdminSecret, (req, res) => {
  try {
    const codeParam = (req.params.code || "").toUpperCase();
    if (!codeParam) return res.status(400).json({ error: "Offer code is required in URL" });

    const offers = loadOffers();
    const idx = offers.findIndex((o) => o.code === codeParam);
    if (idx < 0) return res.status(404).json({ error: "Offer not found" });

    offers[idx].active = false;
    offers[idx].enabled = false;

    saveOffers(offers);
    return res.json({ success: true, offer: offers[idx] });
  } catch (err) {
    console.error("Error in PATCH /api/admin/offers/:code/disable:", err);
    return res.status(500).json({ error: "Failed to disable offer" });
  }
});

app.delete("/api/admin/offers/:code", requireAdminSecret, (req, res) => {
  try {
    const codeParam = (req.params.code || "").toUpperCase();
    if (!codeParam) return res.status(400).json({ error: "Offer code is required in URL" });

    const offers = loadOffers();
    const beforeCount = offers.length;
    const filtered = offers.filter((o) => o.code !== codeParam);
    if (filtered.length === beforeCount) return res.status(404).json({ error: "Offer not found" });

    saveOffers(filtered);
    return res.json({ success: true });
  } catch (err) {
    console.error("Error in DELETE /api/admin/offers/:code:", err);
    return res.status(500).json({ error: "Failed to delete offer" });
  }
});

// Optional legacy PATCH route kept for compatibility
app.patch("/api/admin/offers/:code", requireAdminSecret, (req, res) => {
  try {
    const codeParam = (req.params.code || "").toUpperCase();
    if (!codeParam) return res.status(400).json({ error: "Offer code is required in URL" });

    const offers = loadOffers();
    const idx = offers.findIndex((o) => o.code === codeParam);
    if (idx < 0) return res.status(404).json({ error: "Offer not found" });

    const patch = req.body || {};
    const current = offers[idx];

    if (patch.type) {
      const t = String(patch.type).toUpperCase();
      if (["PERCENT", "FIXED"].includes(t)) current.type = t;
    }

    if (patch.amount !== undefined) {
      const amt = Number(patch.amount);
      if (amt > 0) current.amount = amt;
    }

    if (patch.active !== undefined) {
      current.active = !!patch.active;
      current.enabled = !!patch.active;
    }

    if (patch.description !== undefined) current.description = patch.description || "";

    if (patch.appliesTo) {
      const appliesTo = patch.appliesTo;

      if (Array.isArray(appliesTo.plans)) {
        current.appliesTo.plans = appliesTo.plans.map((p) => String(p || "").trim()).filter(Boolean);
        current.appliesTo.billingTypes = deriveBillingTypesFromPlans(current.appliesTo.plans);
      }

      if (Array.isArray(appliesTo.countries)) {
        current.appliesTo.countries = appliesTo.countries.map((c) => String(c || "").trim()).filter(Boolean);
      }
    }

    if (patch.usageLimit !== undefined) {
      current.usageLimit = patch.usageLimit === null ? null : Number(patch.usageLimit);
    }

    if (patch.validity) {
      current.validity = {
        start: patch.validity.start !== undefined ? patch.validity.start : current.validity.start,
        end: patch.validity.end !== undefined ? patch.validity.end : current.validity.end,
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
function validateOfferForPlan(planId, couponCode) {
  if (!couponCode) return { valid: false };

  const offers = loadOffers();
  if (!offers.length) return { valid: false };

  const now = new Date();
  const code = String(couponCode).trim().toUpperCase();

  const offer = offers.find((o) => (o.code || "").toUpperCase() === code);
  if (!offer) return { valid: false };

  const isActive =
    offer.active !== undefined
      ? !!offer.active
      : offer.enabled !== undefined
      ? !!offer.enabled
      : true;

  if (!isActive) return { valid: false };

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

  let plans = [];
  if (offer.appliesTo && Array.isArray(offer.appliesTo.plans)) plans = offer.appliesTo.plans;
  else if (Array.isArray(offer.applicablePlans)) plans = offer.applicablePlans;

  if (plans.length > 0 && !plans.includes(planId)) return { valid: false };

  return { valid: true, offer };
}

function applyOffer(totalAmount, offer) {
  if (!offer) return { discount: 0, final: totalAmount, description: null };

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

  return { discount, final, description };
}

// ---------------------------------------------------------------------
//  SIMPLE HEALTH CHECK
// ---------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "TGP Razorpay backend is running" });
});

// ---------------------------------------------------------------------
//  THANK-YOU CONTRACT ENDPOINT (v1)
//  GET /api/thank-you-contract?version=v1&order_id=...&payment_id=...&ts=...&sig=...
// ---------------------------------------------------------------------
app.get("/api/thank-you-contract", (req, res) => {
  try {
    if (!THANKYOU_SIG_SECRET) {
      return res.status(500).json({
        version: "v1",
        error: { code: "MISCONFIGURED", message: "THANKYOU_SIG_SECRET not configured." },
      });
    }

    const version = String(req.query.version || "v1");
    const order_id = String(req.query.order_id || "");
    const payment_id = String(req.query.payment_id || "");
    const ts = String(req.query.ts || "");
    const sig = String(req.query.sig || "");

    if (version !== "v1" || !order_id || !payment_id || !ts || !sig) {
      return res.status(400).json({
        version: "v1",
        error: { code: "MISSING_PARAMS", message: "Missing verification params." },
      });
    }

    // Accept seconds(10) or ms(13)
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return res.status(400).json({
        version: "v1",
        error: { code: "INVALID_TS", message: "Invalid timestamp." },
      });
    }
    const tsMs = ts.length >= 13 ? tsNum : tsNum * 1000;
    const ageMs = Math.abs(Date.now() - tsMs);
    if (ageMs > 15 * 60 * 1000) {
      return res.status(401).json({
        version: "v1",
        error: { code: "EXPIRED_TS", message: "Link expired." },
      });
    }

    const expected = signThankYouV1({ order_id, payment_id, ts });
    if (!timingSafeEqualStr(expected, sig)) {
      return res.status(401).json({
        version: "v1",
        error: { code: "INVALID_SIGNATURE", message: "Verification failed." },
      });
    }

    const contract = getThankYouContract({ order_id, payment_id });
    if (!contract) {
      return res.status(404).json({
        version: "v1",
        error: { code: "NOT_FOUND", message: "Contract not found (try again shortly)." },
      });
    }

    return res.json(contract);
  } catch (err) {
    console.error("Error in GET /api/thank-you-contract:", err);
    return res.status(500).json({
      version: "v1",
      error: { code: "INTERNAL_ERROR", message: "Server error." },
    });
  }
});

// ---------------------------------------------------------------------
//  GENERIC CREATE RAZORPAY ORDER (ALREADY USED BY YOUR FRONTEND)
// ---------------------------------------------------------------------
app.post("/create-razorpay-order", async (req, res) => {
  try {
    const { amount, currency, receipt, notes } = req.body;

    if (!amount || !currency || !receipt) {
      return res.status(400).json({
        error: "Missing required fields: amount, currency, or receipt",
      });
    }

    const amountInt = parseInt(amount, 10);
    if (Number.isNaN(amountInt) || amountInt <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const options = {
      amount: amountInt,
      currency: currency || "INR",
      receipt: receipt,
      notes: notes || {},
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
      console.warn("Enterprise order without primary mobile:", { fullName, email });
    }

    if (gstStatus === "yes" && !company) {
      return res.status(400).json({
        success: false,
        error: "Company / Brand name is required when registered with GST.",
      });
    }

    const pkgValue = pkg === "consultation" ? "consultation" : String(pkg);
    let billingTypeValue = (billingType || "monthly").toLowerCase();
    if (billingTypeValue === "subscription") billingTypeValue = "monthly";

    const consultation = pkgValue === "consultation" || Boolean(isConsultation);
    if (consultation) billingTypeValue = "one_time";

    const { base, gst, total } = computeEnterprisePrice(pkgValue, billingTypeValue, country);

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
      offerMeta = { code: result.offer.code, type: result.offer.type, amount: result.offer.amount };
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
      pricing: { base, gst, total, discount, final: finalAmount },
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
      return res.status(400).json({ success: false, error: "plan is required" });
    }

    const planNormalized = plan === "pro" ? "pro" : "starter";
    const basePlanId = planNormalized === "starter" ? "SP_STARTER" : "SP_PRO";

    let base = STARTER_PRO_PLAN_PRICES[basePlanId];
    if (!base) {
      return res.status(400).json({ success: false, error: "Invalid plan" });
    }

    let bt = (billingType || "monthly").toLowerCase();
    if (bt === "subscription") bt = "monthly";

    const planId = basePlanId;

    if (bt === "yearly") {
      const yearlyBeforeDiscount = base * 12;
      base = Math.round(yearlyBeforeDiscount * 0.8);
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
      offerMeta = { code: result.offer.code, type: result.offer.type, amount: result.offer.amount };
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
      pricing: { base, gst, total, discount, final: finalAmount },
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
//  UPDATED: stores thank-you contract + returns ts/sig + canonical thank-you URLs
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

    const orderNotes = orderDetails && orderDetails.notes ? orderDetails.notes : {};

    // -----------------------------
    // Build canonical typed contract (v1) from order notes (source of truth)
    // -----------------------------
    const segment = String(orderNotes.segment || "").toLowerCase(); // "starterpro" | "enterprise" | etc.
    const isEnterprise = segment === "enterprise";

    const pricingBase = Number(orderNotes.basePrice ?? 0) || 0;
    const pricingGst = Number(orderNotes.gstAmount ?? 0) || 0;
    const pricingDiscount = Number(orderNotes.discount ?? 0) || 0;
    const pricingFinal = Number(orderNotes.finalAmount ?? 0) || 0;

    const countryNote = String(orderNotes.country || "").trim();
    const isIndia = countryNote.toLowerCase() === "india";

    const contract = {
      version: "v1",
      kind: isEnterprise ? "enterprise" : "starter_pro",
      context: isEnterprise
        ? {
            package: String(orderNotes.enterprisePackage || "").toLowerCase(), // "60"|"90"|"120"|"consultation"
            billing_type: String(orderNotes.billingType || "").toLowerCase(), // "monthly"|"yearly"|"one_time"
            is_consultation: String(orderNotes.isConsultation || "no").toLowerCase(), // "yes"|"no"
          }
        : {
            plan: String(orderNotes.plan || "").toLowerCase(), // "starter"|"pro"
            billing_type: String(orderNotes.billingType || "").toLowerCase(), // "monthly"|"yearly"
          },
      pricing: {
        base: pricingBase,
        gst: pricingGst,
        discount: pricingDiscount,
        final: pricingFinal,
        currency: "INR",
        is_india: isIndia,
      },
      ids: {
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id,
      },
      display: {
        coupon_code: String(orderNotes.couponCode || "").trim() || undefined,
        offer_label: String(orderNotes.offerDescription || "").trim() || undefined,
      },
    };

    // Store contract (v1)
    storeThankYouContract({
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      contract,
    });

    // Sign thank-you URL params (v1)
    const ts = Date.now().toString(); // ms
    const sig = signThankYouV1({
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      ts,
    });

    const thankYouPath = isEnterprise
      ? "/VVAS_thank-you-enterprise.html"
      : "/VVAS_thank-you.html";

    const thankYouUrl =
      `${thankYouPath}` +
      `?order_id=${encodeURIComponent(razorpay_order_id)}` +
      `&payment_id=${encodeURIComponent(razorpay_payment_id)}` +
      `&ts=${encodeURIComponent(ts)}` +
      `&sig=${encodeURIComponent(sig)}`;

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

    // Backward-compatible response + new typed-thankyou fields
    return res.json({
      success: true,
      message: "Payment verified successfully",

      // NEW: typed thank-you navigation details
      thank_you: {
        kind: contract.kind,
        ts,
        sig,
        url: thankYouUrl,
      },
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
