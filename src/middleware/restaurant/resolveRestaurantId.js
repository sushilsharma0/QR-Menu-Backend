/**
 * Restaurant JWT uses req.user.id as restaurant._id.
 * Employee JWT uses req.user.restaurantId (and req.user.id is the employee).
 */
const resolveRestaurantId = (req) => {
  const u = req.user;
  if (!u) return null;
  if (u.scope === 'branch_user' && u.restaurantId) return String(u.restaurantId);
  if (u.scope === 'employee' && u.restaurantId) return String(u.restaurantId);
  if (u.role === 'restaurant' && u.id) return String(u.id);
  return null;
};

module.exports = resolveRestaurantId;
