const https = require('https');

const CATALOG_URL =
  'https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/countries+states+cities.json';
const COUNTRIES_STATES_URL =
  'https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/countries+states.json';
const COUNTRIES_CITIES_URL =
  'https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/countries+cities.json';

let catalogPromise = null;
let catalogByName = null;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'QR-MENU/1.0' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function findCountry(countryName) {
  if (!catalogByName || !countryName) return null;
  const key = normalizeName(countryName);
  return catalogByName.get(key) || null;
}

async function loadCatalog() {
  if (catalogByName) return catalogByName;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const data = await fetchJson(CATALOG_URL);
        if (!Array.isArray(data)) throw new Error('Invalid catalog');
        const map = new Map();
        data.forEach((country) => {
          const name = String(country?.name || '').trim();
          if (!name) return;
          map.set(normalizeName(name), country);
        });
        catalogByName = map;
        return catalogByName;
      } catch (err) {
        catalogPromise = null;
        throw err;
      }
    })();
  }
  return catalogPromise;
}

async function loadStatesFallback(countryName) {
  const data = await fetchJson(COUNTRIES_STATES_URL);
  if (!Array.isArray(data)) return [];
  const row = data.find((c) => normalizeName(c.name) === normalizeName(countryName));
  const states = row?.states || [];
  return states.map((name) => ({ id: name, name: String(name) }));
}

async function loadDistrictsFallback(countryName) {
  const data = await fetchJson(COUNTRIES_CITIES_URL);
  if (!Array.isArray(data)) return [];
  const row = data.find((c) => normalizeName(c.name) === normalizeName(countryName));
  const cities = row?.cities || [];
  return cities.map((name) => ({ id: name, name: String(name) }));
}

async function getStatesForCountry(countryName) {
  const name = String(countryName || '').trim();
  if (!name) return [];

  try {
    await loadCatalog();
    const country = findCountry(name);
    const states = country?.states || [];
    return states
      .map((s) => ({
        id: s.id,
        name: String(s.name || '').trim(),
        type: s.type || '',
      }))
      .filter((s) => s.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return loadStatesFallback(name);
  }
}

async function getDistrictsForState(countryName, stateName) {
  const country = String(countryName || '').trim();
  const state = String(stateName || '').trim();
  if (!country || !state) return [];

  try {
    await loadCatalog();
    const countryRow = findCountry(country);
    const stateRow = (countryRow?.states || []).find(
      (s) => normalizeName(s.name) === normalizeName(state),
    );
    const cities = stateRow?.cities || [];
    if (cities.length) {
      return cities
        .map((c) => ({
          id: c.id,
          name: String(c.name || '').trim(),
        }))
        .filter((c) => c.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    /* fall through */
  }

  return loadDistrictsFallback(country);
}

// Warm catalog in background after server boot (first user request is faster).
setTimeout(() => {
  loadCatalog().catch(() => {});
}, 3000);

module.exports = {
  getStatesForCountry,
  getDistrictsForState,
};
