// plansConfig.js
// Canonical list of all VVAS plans for Offers Engine + /plans API

module.exports = [
  // ───────────────── SUBSCRIPTIONS ─────────────────

  {
    id: "starter_subscription",
    label: "Starter – Subscription",
    product: "VVAS",
    tier: "starter",
    kind: "subscription",
    billingGroup: "subscription",   // used for filters / derived billingTypes
    sortOrder: 10,
  },
  {
    id: "pro_subscription",
    label: "Pro – Subscription",
    product: "VVAS",
    tier: "pro",
    kind: "subscription",
    billingGroup: "subscription",
    sortOrder: 20,
  },

  // Enterprise subscription buckets
  {
    id: "enterprise_60_monthly",
    label: "Enterprise 60 – Monthly",
    product: "VVAS",
    tier: "enterprise_60",
    kind: "subscription",
    billingGroup: "monthly",
    sortOrder: 40,
  },
  {
    id: "enterprise_60_yearly",
    label: "Enterprise 60 – Yearly",
    product: "VVAS",
    tier: "enterprise_60",
    kind: "subscription",
    billingGroup: "yearly",
    sortOrder: 41,
  },
  {
    id: "enterprise_90_monthly",
    label: "Enterprise 90 – Monthly",
    product: "VVAS",
    tier: "enterprise_90",
    kind: "subscription",
    billingGroup: "monthly",
    sortOrder: 50,
  },
  {
    id: "enterprise_90_yearly",
    label: "Enterprise 90 – Yearly",
    product: "VVAS",
    tier: "enterprise_90",
    kind: "subscription",
    billingGroup: "yearly",
    sortOrder: 51,
  },
  {
    id: "enterprise_120_monthly",
    label: "Enterprise 120 – Monthly",
    product: "VVAS",
    tier: "enterprise_120",
    kind: "subscription",
    billingGroup: "monthly",
    sortOrder: 60,
  },
  {
    id: "enterprise_120_yearly",
    label: "Enterprise 120 – Yearly",
    product: "VVAS",
    tier: "enterprise_120",
    kind: "subscription",
    billingGroup: "yearly",
    sortOrder: 61,
  },

  // ───────────────── ONE-TIME PROJECTS ─────────────────

  {
    id: "starter_one_time",
    label: "Starter – One-time",
    product: "VVAS",
    tier: "starter",
    kind: "one_time",
    billingGroup: "one_time",
    sortOrder: 110,
  },
  {
    id: "pro_one_time",
    label: "Pro – One-time",
    product: "VVAS",
    tier: "pro",
    kind: "one_time",
    billingGroup: "one_time",
    sortOrder: 120,
  },

  // Videos – one-time
  {
    id: "one_time_60_videos",
    label: "One-time – Up to 60 Videos",
    product: "VVAS",
    tier: "videos_60",
    kind: "one_time",
    billingGroup: "one_time",
    sortOrder: 130,
  },
  {
    id: "one_time_90_videos",
    label: "One-time – Up to 90 Videos",
    product: "VVAS",
    tier: "videos_90",
    kind: "one_time",
    billingGroup: "one_time",
    sortOrder: 131,
  },
  {
    id: "one_time_120_videos",
    label: "One-time – Up to 120 Videos",
    product: "VVAS",
    tier: "videos_120",
    kind: "one_time",
    billingGroup: "one_time",
    sortOrder: 132,
  },

  // Consultation – canonical 60-min plan
  {
    id: "one_time_consult_60",
    label: "One-time – 60-min Consultation",
    product: "VVAS",
    tier: "consult_60",
    kind: "one_time",
    billingGroup: "one_time",
    sortOrder: 200,
    // for backwards compatibility with older offers:
    legacyIds: ["enterprise_consultation_call_one_time"],
  },
];
