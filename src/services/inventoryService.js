const Inventory = require('../models/restaurant/Inventory');

const deductInventory = async (restaurantId, items) => {
  const results = [];
  
  for (const item of items) {
    const inventoryItem = await Inventory.findOne({
      restaurant: restaurantId,
      menuItem: item.menuItem
    });
    
    if (inventoryItem) {
      const newQuantity = inventoryItem.quantity - item.quantity;
      
      if (newQuantity < 0) {
        throw new Error(`Insufficient inventory for ${inventoryItem.name}`);
      }
      
      inventoryItem.quantity = newQuantity;
      await inventoryItem.save();
      
      results.push({
        name: inventoryItem.name,
        newQuantity,
        deducted: item.quantity
      });
    }
  }
  
  return results;
};

const checkInventory = async (restaurantId, items) => {
  for (const item of items) {
    const inventoryItem = await Inventory.findOne({
      restaurant: restaurantId,
      menuItem: item.menuItem
    });
    
    if (inventoryItem && inventoryItem.quantity < item.quantity) {
      return {
        available: false,
        item: inventoryItem.name,
        requested: item.quantity,
        available: inventoryItem.quantity
      };
    }
  }
  
  return { available: true };
};

module.exports = { deductInventory, checkInventory };