const PASSWORD_CHANGE_REMINDER_DAYS =
  parseInt(process.env.RESTAURANT_PASSWORD_CHANGE_REMINDER_DAYS, 10) || 60;
const PASSWORD_CHANGE_REMINDER_LOGINS =
  parseInt(process.env.RESTAURANT_PASSWORD_CHANGE_REMINDER_LOGINS, 10) || 50;

const buildPasswordChangeRecommendation = (restaurant) => {
  const passwordChangedAt = restaurant.passwordChangedAt || restaurant.createdAt;
  const passwordAgeDays = passwordChangedAt
    ? Math.floor((Date.now() - new Date(passwordChangedAt).getTime()) / (24 * 60 * 60 * 1000))
    : 0;
  const successfulLoginCount = Number(restaurant.successfulLoginCount || 0);
  const dueByAge = passwordAgeDays >= PASSWORD_CHANGE_REMINDER_DAYS;
  const dueByLogins = successfulLoginCount >= PASSWORD_CHANGE_REMINDER_LOGINS;

  return {
    recommended: Boolean(dueByAge || dueByLogins),
    required: Boolean(dueByAge || dueByLogins),
    reason: dueByAge ? 'age' : dueByLogins ? 'logins' : null,
    passwordAgeDays: Math.max(0, passwordAgeDays),
    successfulLoginCount,
    reminderAfterDays: PASSWORD_CHANGE_REMINDER_DAYS,
    reminderAfterLogins: PASSWORD_CHANGE_REMINDER_LOGINS,
    passwordChangedAt: passwordChangedAt || null,
  };
};

module.exports = {
  buildPasswordChangeRecommendation,
  PASSWORD_CHANGE_REMINDER_DAYS,
  PASSWORD_CHANGE_REMINDER_LOGINS,
};
