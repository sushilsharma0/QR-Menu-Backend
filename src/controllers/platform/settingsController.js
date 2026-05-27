const asyncHandler = require('express-async-handler');
const PlatformSiteSettings = require('../../models/platform/PlatformSiteSettings');
const CustomerFeedback = require('../../models/customer/CustomerFeedback');
const ManualPaymentSettings = require('../../models/platform/ManualPaymentSettings');
const { success, error } = require('../../utils/apiResponse');

const LANDING_THEMES = ['default', 'ocean', 'sunset', 'forest', 'midnight', 'rose'];
const CHAT_MODES = ['whatsapp', 'phone', 'both'];

const brandingResponse = (settings) => ({
  softwareName: settings.softwareName ?? 'QR Restro Nepal',
  brandSubtitle: settings.brandSubtitle ?? 'Nepal',
  landingLogo: settings.landingLogo ?? '',
  publicSiteUrl: settings.publicSiteUrl ?? '',
  supportEmail: settings.supportEmail ?? '',
  contactPhone: settings.contactPhone ?? '',
  landingTheme: LANDING_THEMES.includes(settings.landingTheme) ? settings.landingTheme : 'default',
  heroEyebrow: settings.heroEyebrow ?? '',
  heroTitle: settings.heroTitle ?? '',
  heroDescription: settings.heroDescription ?? '',
  heroSubDescription: settings.heroSubDescription ?? '',
  heroImage: settings.heroImage ?? '',
  heroTypewriterPhrases: settings.heroTypewriterPhrases ?? '',
  heroPrimaryCtaText: settings.heroPrimaryCtaText ?? '',
  heroPrimaryCtaHref: settings.heroPrimaryCtaHref ?? '',
  heroSecondaryCtaText: settings.heroSecondaryCtaText ?? '',
  heroSecondaryCtaHref: settings.heroSecondaryCtaHref ?? '',
  heroBulletPoints: settings.heroBulletPoints ?? '',
  footerTagline: settings.footerTagline ?? '',
  footerCtaTitle: settings.footerCtaTitle ?? '',
  footerCtaSubtitle: settings.footerCtaSubtitle ?? '',
  chatWidgetEnabled: settings.chatWidgetEnabled !== false,
  chatWidgetMode: CHAT_MODES.includes(settings.chatWidgetMode) ? settings.chatWidgetMode : 'whatsapp',
  chatWhatsappNumber: settings.chatWhatsappNumber ?? '9779800000000',
  chatWhatsappMessage: settings.chatWhatsappMessage ?? 'Hi, I want to know more about the platform.',
  chatDisplayPhone: settings.chatDisplayPhone ?? '',
});

/** Safe payload for unauthenticated landing page */
const buildPublicLandingPayload = (settings) => ({
  softwareName: settings.softwareName || 'QR Restro Nepal',
  brandSubtitle: settings.brandSubtitle || '',
  landingLogo: settings.landingLogo || '',
  publicSiteUrl: settings.publicSiteUrl || '',
  supportEmail: settings.supportEmail || '',
  contactPhone: settings.contactPhone || '',
  landingTheme: LANDING_THEMES.includes(settings.landingTheme) ? settings.landingTheme : 'default',
  hero: {
    eyebrow: settings.heroEyebrow || '',
    title: settings.heroTitle || '',
    description: settings.heroDescription || '',
    subDescription: settings.heroSubDescription || '',
    image: settings.heroImage || '',
    typewriterPhrases: settings.heroTypewriterPhrases || '',
    primaryCtaText: settings.heroPrimaryCtaText || '',
    primaryCtaHref: settings.heroPrimaryCtaHref || '',
    secondaryCtaText: settings.heroSecondaryCtaText || '',
    secondaryCtaHref: settings.heroSecondaryCtaHref || '',
    bulletPoints: settings.heroBulletPoints || '',
  },
  footer: {
    tagline: settings.footerTagline || '',
    ctaTitle: settings.footerCtaTitle || '',
    ctaSubtitle: settings.footerCtaSubtitle || '',
  },
  chat: {
    enabled: settings.chatWidgetEnabled !== false,
    mode: CHAT_MODES.includes(settings.chatWidgetMode) ? settings.chatWidgetMode : 'whatsapp',
    whatsappNumber: settings.chatWhatsappNumber || '',
    whatsappMessage: settings.chatWhatsappMessage || '',
    displayPhone: settings.chatDisplayPhone || settings.contactPhone || '',
  },
});

const getPublicLandingSiteConfig = asyncHandler(async (req, res) => {
  const settings = await PlatformSiteSettings.getSingleton();
  return success(res, buildPublicLandingPayload(settings), 'Landing site config');
});

const getSiteSettings = asyncHandler(async (req, res) => {
  const settings = await PlatformSiteSettings.getSingleton();
  const [total, publicCount, averageAgg] = await Promise.all([
    CustomerFeedback.countDocuments({ isActive: true }),
    CustomerFeedback.countDocuments({ isActive: true, isPublic: true }),
    CustomerFeedback.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: null, averageSystemRating: { $avg: '$systemRating' } } },
    ]),
  ]);

  return success(res, {
    feedbackEnabled: settings.feedbackEnabled,
    showFeedbackOnLanding: settings.showFeedbackOnLanding,
    feedbackSummary: {
      total,
      publicCount,
      averageSystemRating: Number((averageAgg[0]?.averageSystemRating || 0).toFixed(1)),
    },
    ...brandingResponse(settings),
  }, 'Platform site settings retrieved');
});

const updateSiteSettings = asyncHandler(async (req, res) => {
  const settings = await PlatformSiteSettings.getSingleton();
  const isSuper = req.user.role === 'super_admin';
  const { feedbackEnabled, showFeedbackOnLanding } = req.body;

  if (typeof feedbackEnabled !== 'undefined') {
    settings.feedbackEnabled = feedbackEnabled === true || feedbackEnabled === 'true';
  }
  if (typeof showFeedbackOnLanding !== 'undefined') {
    settings.showFeedbackOnLanding = showFeedbackOnLanding === true || showFeedbackOnLanding === 'true';
  }

  if (isSuper) {
    const trimFields = [
      'softwareName', 'brandSubtitle', 'publicSiteUrl', 'supportEmail', 'contactPhone',
      'heroEyebrow', 'heroTitle', 'heroDescription', 'heroSubDescription', 'heroImage', 'heroTypewriterPhrases',
      'heroPrimaryCtaText', 'heroPrimaryCtaHref', 'heroSecondaryCtaText', 'heroSecondaryCtaHref', 'heroBulletPoints',
      'footerTagline', 'footerCtaTitle', 'footerCtaSubtitle',
      'chatWhatsappNumber', 'chatWhatsappMessage', 'chatDisplayPhone',
    ];
    trimFields.forEach((key) => {
      if (typeof req.body[key] !== 'undefined') {
        settings[key] = String(req.body[key] ?? '').trim();
      }
    });
    if (typeof req.body.chatWidgetEnabled !== 'undefined') {
      settings.chatWidgetEnabled = req.body.chatWidgetEnabled === true || req.body.chatWidgetEnabled === 'true';
    }
    if (typeof req.body.landingTheme === 'string' && LANDING_THEMES.includes(req.body.landingTheme)) {
      settings.landingTheme = req.body.landingTheme;
    }
    if (typeof req.body.chatWidgetMode === 'string' && CHAT_MODES.includes(req.body.chatWidgetMode)) {
      settings.chatWidgetMode = req.body.chatWidgetMode;
    }
    if (req.file?.path) {
      settings.landingLogo = req.file.path;
    }
  }

  await settings.save();

  const [total, publicCount, averageAgg] = await Promise.all([
    CustomerFeedback.countDocuments({ isActive: true }),
    CustomerFeedback.countDocuments({ isActive: true, isPublic: true }),
    CustomerFeedback.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: null, averageSystemRating: { $avg: '$systemRating' } } },
    ]),
  ]);

  return success(res, {
    feedbackEnabled: settings.feedbackEnabled,
    showFeedbackOnLanding: settings.showFeedbackOnLanding,
    feedbackSummary: {
      total,
      publicCount,
      averageSystemRating: Number((averageAgg[0]?.averageSystemRating || 0).toFixed(1)),
    },
    ...brandingResponse(settings),
  }, 'Platform site settings updated');
});

const getManualPaymentSettings = asyncHandler(async (req, res) => {
  const settings = await ManualPaymentSettings.getSingleton();
  return success(res, settings, 'Manual payment settings retrieved');
});

const updateManualPaymentSettings = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'super_admin') {
    return error(res, 'Only super admin can update manual payment settings', 403);
  }

  const settings = await ManualPaymentSettings.getSingleton();
  const { accountName, accountNumber, branch, notes } = req.body;

  if (typeof accountName !== 'undefined') settings.accountName = String(accountName || '').trim();
  if (typeof accountNumber !== 'undefined') settings.accountNumber = String(accountNumber || '').trim();
  if (typeof branch !== 'undefined') settings.branch = String(branch || '').trim();
  if (typeof notes !== 'undefined') settings.notes = String(notes || '').trim();

  if (req.file?.path) {
    settings.qrCodeImage = req.file.path;
  }

  await settings.save();
  return success(res, settings, 'Manual payment settings updated');
});

module.exports = {
  getSiteSettings,
  updateSiteSettings,
  getManualPaymentSettings,
  updateManualPaymentSettings,
  getPublicLandingSiteConfig,
  buildPublicLandingPayload,
};
