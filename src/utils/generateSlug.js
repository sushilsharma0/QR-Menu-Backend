const slugify = require('slugify');

const generateSlug = (text, options = {}) => {
  return slugify(text, {
    lower: true,
    strict: true,
    remove: /[*+~.()'"!:@]/g,
    ...options
  });
};

const generateUniqueSlug = async (text, model, field = 'slug', counter = 0) => {
  let slug = generateSlug(text);
  if (counter > 0) slug = `${slug}-${counter}`;
  
  const exists = await model.findOne({ [field]: slug });
  if (exists) return generateUniqueSlug(text, model, field, counter + 1);
  
  return slug;
};

module.exports = { generateSlug, generateUniqueSlug };