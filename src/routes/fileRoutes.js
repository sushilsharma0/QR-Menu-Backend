const express = require('express');
const { serveSignedFile } = require('../controllers/fileController');

const router = express.Router();

router.get('/:token', serveSignedFile);

module.exports = router;
