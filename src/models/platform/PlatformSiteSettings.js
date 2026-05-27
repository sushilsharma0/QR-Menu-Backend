const mongoose = require('mongoose');

const THEME_ENUM = ['default', 'ocean', 'sunset', 'forest', 'midnight', 'rose'];
const CHAT_MODE_ENUM = ['whatsapp', 'phone', 'both'];

const platformSiteSettingsSchema = new mongoose.Schema({
  singletonKey: { type: String, unique: true, default: 'platform-site-settings' },
  feedbackEnabled: { type: Boolean, default: true },
  showFeedbackOnLanding: { type: Boolean, default: true },

  /** Public marketing / landing (maintained by super admin) */
  softwareName: { type: String, default: 'QR Restro Nepal' },
  brandSubtitle: { type: String, default: 'Nepal' },
  landingLogo: { type: String, default: '' },
  /** Shown in footer/meta — your live domain or canonical URL (does not change DNS). */
  publicSiteUrl: { type: String, default: '' },
  supportEmail: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  landingTheme: { type: String, enum: THEME_ENUM, default: 'default' },

  heroEyebrow: { type: String, default: '' },
  heroTitle: { type: String, default: '' },
  heroDescription: { type: String, default: '' },
  heroSubDescription: { type: String, default: '' },
  heroImage: { type: String, default: '' },
  /** Comma or newline separated phrases for the hero typewriter */
  heroTypewriterPhrases: { type: String, default: '' },
  heroPrimaryCtaText: { type: String, default: '' },
  /** Path (e.g. /vendor/register) or full URL */
  heroPrimaryCtaHref: { type: String, default: '' },
  heroSecondaryCtaText: { type: String, default: '' },
  heroSecondaryCtaHref: { type: String, default: '' },
  /** Newline-separated short bullets under hero CTAs (up to 4 lines used) */
  heroBulletPoints: { type: String, default: '' },

  footerTagline: { type: String, default: '' },
  footerCtaTitle: { type: String, default: '' },
  footerCtaSubtitle: { type: String, default: '' },

  chatWidgetEnabled: { type: Boolean, default: true },
  chatWidgetMode: { type: String, enum: CHAT_MODE_ENUM, default: 'whatsapp' },
  /** Digits only, country code included, no + */
  chatWhatsappNumber: { type: String, default: '9779800000000' },
  chatWhatsappMessage: { type: String, default: 'Hi, I want to know more about the platform.' },
  /** Shown in popup and used for tel: when mode includes phone */
  chatDisplayPhone: { type: String, default: '' },
}, { timestamps: true });

platformSiteSettingsSchema.statics.getSingleton = async function getSingleton() {
  let settings = await this.findOne({ singletonKey: 'platform-site-settings' });
  if (!settings) {
    settings = await this.create({ singletonKey: 'platform-site-settings' });
  }
  return settings;
};

module.exports = mongoose.model('PlatformSiteSettings', platformSiteSettingsSchema);
