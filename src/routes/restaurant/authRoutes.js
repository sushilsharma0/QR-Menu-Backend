const express = require("express");
const router = express.Router();
const {
  register,
  verifyRegistration,
  resendRegistrationCode,
  checkReferralCode,
  login,
  logout,
  refreshToken,
  getSessions,
  getLoginHistory,
  revokeSession,
  revokeOtherSessions,
  updateCurrentSessionLocation,
  forgotPassword,
  validateResetCode,
  resetPassword,
  getProfile,
  updateProfile,
  changePassword,
  verifyPassword,
  getAccessSession,
  dismissTrialWelcome,
  getPublicLoginPolicy,
} = require("../../controllers/restaurant/authController");
const { authLimiter, passwordResetLimiter } = require("../../middleware/rateLimiter");
const verifyToken = require("../../middleware/auth/verifyToken");
const requireRole = require("../../middleware/auth/requireRole");
const upload = require("../../config/multer");
const requireRestaurantSubscriptionAccess = require("../../middleware/restaurant/requireRestaurantSubscriptionAccess");
const requireRestaurantPlanFeature = require("../../middleware/restaurant/requireRestaurantPlanFeature");

// Public routes
router.post("/register", authLimiter, register);
router.post("/verify-registration", authLimiter, verifyRegistration);
router.post("/resend-registration-code", authLimiter, resendRegistrationCode);
router.post("/check-referral-code", authLimiter, checkReferralCode);
router.get("/login-policy", getPublicLoginPolicy);
router.post("/login", authLimiter, login);
router.post("/logout", verifyToken, requireRole("restaurant"), logout);
// Do not use authLimiter here — inventory loads fire parallel 401→refresh retries and
// would burn the login attempt budget / rotate refresh tokens concurrently.
router.post("/refresh", refreshToken);
router.post("/forgot-password", passwordResetLimiter, forgotPassword);
router.post("/validate-reset-code", passwordResetLimiter, validateResetCode);
router.post("/reset-password", passwordResetLimiter, resetPassword);

// Protected routes — GET profile is used across the restaurant portal (incl. employees) to
// load restaurant identity; keep it outside subscription/plan gates so the UI can route users
// to billing/KYC. Mutating profile/password stays gated below.
const restaurantPortalRoles = [
  "restaurant",
  "admin",
  "manager",
  "kitchen",
  "cashier",
  "waiter",
  "accountant",
];
const branchPortalRoles = [
  "branch_admin",
  "branch_manager",
  "branch_cashier",
  "branch_waiter",
  "branch_kitchen",
];
router.get(
  "/profile",
  verifyToken,
  requireRole(...restaurantPortalRoles, ...branchPortalRoles),
  getProfile,
);
router.get(
  "/access",
  verifyToken,
  requireRole("restaurant"),
  getAccessSession,
);
router.post(
  "/dismiss-trial-welcome",
  verifyToken,
  requireRole("restaurant"),
  dismissTrialWelcome,
);
router.put(
  "/profile",
  verifyToken,
  requireRole("restaurant", "branch_admin"),
  requireRestaurantSubscriptionAccess,
  requireRestaurantPlanFeature("accountSettings"),
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'backgroundPhoto', maxCount: 1 },
    { name: 'favicon', maxCount: 1 },
    { name: 'brandBackgroundImage', maxCount: 1 }
  ]),
  updateProfile,
);
router.post(
  "/change-password",
  verifyToken,
  requireRole("restaurant"),
  changePassword,
);
router.post(
  "/verify-password",
  verifyToken,
  requireRole("restaurant"),
  requireRestaurantSubscriptionAccess,
  requireRestaurantPlanFeature("accountSettings"),
  verifyPassword,
);

router.get(
  "/sessions",
  verifyToken,
  requireRole("restaurant"),
  getSessions,
);
router.get(
  "/login-history",
  verifyToken,
  requireRole("restaurant"),
  getLoginHistory,
);
router.delete(
  "/sessions/:sessionId",
  verifyToken,
  requireRole("restaurant"),
  revokeSession,
);
router.post(
  "/sessions/revoke-others",
  verifyToken,
  requireRole("restaurant"),
  revokeOtherSessions,
);
router.patch(
  "/sessions/current/location",
  verifyToken,
  requireRole("restaurant"),
  updateCurrentSessionLocation,
);

// Test endpoint to verify token works
router.get("/verify", verifyToken, requireRole("restaurant"), (req, res) => {
  res.json({ success: true, message: "Token is valid", user: req.user });
});

module.exports = router;
