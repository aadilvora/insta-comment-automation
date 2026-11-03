/**
 * Invest With Clarity - Message Template Routes
 * A reusable library of message wording, so the creator can change what the
 * automation says without ever touching source code.
 */

const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute } = require('../database/db');
const LoggerService = require('../services/loggerService');

const TYPES = ['public_reply', 'private_reply', 'follow_up', 'reminder', 'report'];

router.get('/', (req, res) => {
  try {
    const { type } = req.query;
    const templates = type && type !== 'ALL'
      ? queryAll('SELECT * FROM message_templates WHERE message_type = ? ORDER BY id DESC', [type])
      : queryAll('SELECT * FROM message_templates ORDER BY id DESC');

    res.json({ success: true, templates, types: TYPES });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, message_type, body, notes = null } = req.body || {};

    if (!name || !message_type || !body) {
      return res.status(400).json({
        success: false,
        error: 'A template needs a name, a type and a message body.'
      });
    }
    if (!TYPES.includes(message_type)) {
      return res.status(400).json({ success: false, error: `Unknown template type "${message_type}".` });
    }

    execute(
      'INSERT INTO message_templates (name, message_type, body, notes) VALUES (?, ?, ?, ?)',
      [name, message_type, body, notes]
    );

    const created = queryOne('SELECT * FROM message_templates ORDER BY id DESC LIMIT 1');

    LoggerService.log({
      action: 'TEMPLATE_CREATED',
      status: 'SUCCESS',
      details: { name, message_type }
    });

    res.status(201).json({ success: true, template: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const existing = queryOne('SELECT * FROM message_templates WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const {
      name = existing.name,
      message_type = existing.message_type,
      body = existing.body,
      notes = existing.notes
    } = req.body || {};

    execute(
      `UPDATE message_templates
          SET name = ?, message_type = ?, body = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [name, message_type, body, notes, req.params.id]
    );

    res.json({
      success: true,
      template: queryOne('SELECT * FROM message_templates WHERE id = ?', [req.params.id])
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    execute('DELETE FROM message_templates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
