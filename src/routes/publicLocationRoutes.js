const express = require('express');
const router = express.Router();
const { success, error } = require('../utils/apiResponse');
const {
  getStatesForCountry,
  getDistrictsForState,
} = require('../services/locationCatalogService');

router.get('/states', async (req, res) => {
  try {
    const country = String(req.query.country || '').trim();
    if (!country) return error(res, 'country query is required', 400);
    const states = await getStatesForCountry(country);
    return success(res, { states }, 'States retrieved');
  } catch (err) {
    console.error('location states error', err);
    return error(res, 'Failed to load states', 500);
  }
});

router.get('/districts', async (req, res) => {
  try {
    const country = String(req.query.country || '').trim();
    const state = String(req.query.state || '').trim();
    if (!country) return error(res, 'country query is required', 400);
    if (!state) return error(res, 'state query is required', 400);
    const districts = await getDistrictsForState(country, state);
    return success(res, { districts }, 'Districts retrieved');
  } catch (err) {
    console.error('location districts error', err);
    return error(res, 'Failed to load districts', 500);
  }
});

module.exports = router;
