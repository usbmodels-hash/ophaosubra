'use strict';

const AIRTABLE_API = 'https://api.airtable.com/v0';
const AIRTABLE_META_API = 'https://api.airtable.com/v0/meta';

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;

const OPERATORS_TABLE = process.env.AIRTABLE_OPERATORS_TABLE_ID || 'tblHrWysOvgHlOgd5';
const CONTACTS_TABLE = process.env.AIRTABLE_CONTACTS_TABLE_ID || 'tbl6Bi3TK5wRlZkUa';
const INTERACTIONS_TABLE = process.env.AIRTABLE_INTERACTIONS_TABLE_ID || 'Interacciones Portal';

const memoryRateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 8;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  },
  body: JSON.stringify(body)
});

function text(value, max = 5000) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function bool(value) {
  return value === true || value === 'true' || value === 'on' || value === '1';
}

function normalizeEmail(value) {
  return text(value, 320).toLowerCase();
}

function normalizeHost(url) {
  const raw = text(url, 500).toLowerCase();
  if (!raw) return '';
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.replace(/^www\./, '');
  } catch (_) {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

function normalizeUrl(url) {
  const raw = text(url, 500);
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function escapeFormulaString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function required(data, key) {
  return text(data[key]).length > 0;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function rateLimitKey(event) {
  const headers = event.headers || {};
  return headers['x-nf-client-connection-ip'] || headers['client-ip'] || headers['x-forwarded-for'] || 'unknown';
}

function checkRateLimit(event) {
  const key = rateLimitKey(event);
  const now = Date.now();
  const current = memoryRateLimit.get(key) || [];
  const recent = current.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  memoryRateLimit.set(key, recent);
  return recent.length <= RATE_LIMIT_MAX;
}

async function airtableFetch(path, options = {}) {
  if (!BASE_ID || !TOKEN) {
    throw new Error('Missing AIRTABLE_BASE_ID or AIRTABLE_TOKEN environment variable.');
  }
  const res = await fetch(`${AIRTABLE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = payload?.error?.message || payload?.error?.type || `Airtable error ${res.status}`;
    const error = new Error(msg);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function airtableMetaFetch(path) {
  const res = await fetch(`${AIRTABLE_META_API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error?.message || 'Airtable metadata API unavailable');
  return payload;
}

async function getSchema() {
  try {
    const meta = await airtableMetaFetch(`/bases/${BASE_ID}/tables`);
    const byIdOrName = new Map();
    for (const table of meta.tables || []) {
      const fields = new Map((table.fields || []).map(f => [f.name, f]));
      byIdOrName.set(table.id, { id: table.id, name: table.name, fields });
      byIdOrName.set(table.name, { id: table.id, name: table.name, fields });
    }
    return { available: true, byIdOrName };
  } catch (err) {
    console.warn('Schema check skipped:', err.message);
    return { available: false, byIdOrName: new Map() };
  }
}

function tableSchema(schema, tableRef) {
  return schema.available ? schema.byIdOrName.get(tableRef) : null;
}

function hasField(schema, tableRef, fieldName) {
  const table = tableSchema(schema, tableRef);
  if (!schema.available) return true;
  return Boolean(table && table.fields.has(fieldName));
}

function addField(fields, schema, tableRef, fieldName, value, warnings) {
  if (value === undefined || value === null || value === '') return;
  if (hasField(schema, tableRef, fieldName)) fields[fieldName] = value;
  else warnings.missingFields.push(`${tableRef}.${fieldName}`);
}

function addDateField(fields, schema, tableRef, fieldName, warnings) {
  const now = new Date();
  const table = tableSchema(schema, tableRef);
  let value = now.toISOString();
  if (table && table.fields.has(fieldName)) {
    const type = table.fields.get(fieldName).type;
    if (type === 'date') value = now.toISOString().slice(0, 10);
  }
  addField(fields, schema, tableRef, fieldName, value, warnings);
}

async function listOne(tableRef, filterByFormula) {
  const params = new URLSearchParams({ maxRecords: '1', pageSize: '1', filterByFormula });
  const path = `/${BASE_ID}/${encodeURIComponent(tableRef)}?${params.toString()}`;
  const data = await airtableFetch(path);
  return data.records && data.records[0] ? data.records[0] : null;
}

async function findOperator(data) {
  const websiteHost = normalizeHost(data.companyWebsite);
  const email = normalizeEmail(data.email);
  const company = text(data.company, 300).toLowerCase();
  if (websiteHost) {
    const formula = `FIND('${escapeFormulaString(websiteHost)}', LOWER({Website} & '')) > 0`;
    const rec = await listOne(OPERATORS_TABLE, formula);
    if (rec) return rec;
  }
  if (email) {
    const formula = `LOWER({Email principal} & '') = '${escapeFormulaString(email)}'`;
    const rec = await listOne(OPERATORS_TABLE, formula);
    if (rec) return rec;
  }
  if (company) {
    const formula = `LOWER({Operador} & '') = '${escapeFormulaString(company)}'`;
    const rec = await listOne(OPERATORS_TABLE, formula);
    if (rec) return rec;
  }
  return null;
}

async function findContact(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const formula = `LOWER({Email} & '') = '${escapeFormulaString(normalized)}'`;
  return listOne(CONTACTS_TABLE, formula);
}

function pipelineFromRequest(data) {
  const requestDataRoom = bool(data.requestDataRoom);
  const requestNda = bool(data.requestNda);
  const requestMeeting = bool(data.requestMeeting);
  if (requestMeeting) {
    return {
      estado: 'Contactado',
      proxima: 'Llamar',
      resultado: 'Solicita reunión',
      preparado: false
    };
  }
  if (requestNda) {
    return {
      estado: 'Contactado',
      proxima: 'Enviar NDA',
      resultado: 'Solicita NDA',
      preparado: false
    };
  }
  if (requestDataRoom) {
    return {
      estado: 'Enviar Info',
      proxima: 'Enviar informacion',
      resultado: undefined,
      preparado: true
    };
  }
  return {
    estado: 'Lead',
    proxima: 'Enviar informacion',
    resultado: undefined,
    preparado: false
  };
}

function appendBlock(existing, title, lines) {
  const cleanLines = lines.filter(Boolean);
  if (!cleanLines.length) return existing || '';
  const block = `${title}\n${cleanLines.map(line => `- ${line}`).join('\n')}`;
  return existing ? `${existing}\n\n${block}` : block;
}

function buildOperatorFields(data, schema, existingRecord, warnings) {
  const pipeline = pipelineFromRequest(data);
  const fields = {};
  const requestDataRoom = bool(data.requestDataRoom);
  const requestNda = bool(data.requestNda);
  const requestMeeting = bool(data.requestMeeting);
  const existing = existingRecord?.fields || {};
  const noteTitle = `[Portal OPHAO SUBRA] ${new Date().toISOString()}`;
  const comments = text(data.comments, 3000);
  const appendedNotes = appendBlock(existing['Notas'], noteTitle, [
    `Modelo de interés: ${text(data.interestModel, 120)}`,
    `Nivel de interés: ${text(data.interestLevel, 80)}`,
    `Solicita Data Room: ${requestDataRoom ? 'Sí' : 'No'}`,
    `Solicita NDA: ${requestNda ? 'Sí' : 'No'}`,
    `Solicita reunión: ${requestMeeting ? 'Sí' : 'No'}`,
    comments ? `Comentarios: ${comments}` : ''
  ]);
  const appendedPortalComments = appendBlock(existing['Comentarios portal'], noteTitle, [comments || 'Solicitud recibida desde formulario de acceso.']);
  addField(fields, schema, OPERATORS_TABLE, 'Operador', text(data.company, 300), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Website', normalizeUrl(data.companyWebsite), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'País', text(data.country, 120), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Tipo estimado / Tipo de operador', text(data.operatorType, 160), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Estado Pipeline', pipeline.estado, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Email principal', normalizeEmail(data.email), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Teléfono principal', text(data.phone, 80), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Canal contacto', 'Portal OPHAO SUBRA', warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Contacto principal', text(data.contactName, 200), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Notas', appendedNotes, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Proxima accion', pipeline.proxima, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Preparado automatizacion', pipeline.preparado, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Resultado llamada', pipeline.resultado, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Reunion solicitada', requestMeeting, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Modelo interes portal', text(data.interestModel, 160), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Nivel interes portal', text(data.interestLevel, 80), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Solicita Data Room', requestDataRoom, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Solicita NDA', requestNda, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Solicita reunion', requestMeeting, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Comentarios portal', appendedPortalComments, warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Idioma portal', text(data.language, 10).toUpperCase(), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Origen portal', 'OPHAO SUBRA Landing', warnings);
  addField(fields, schema, OPERATORS_TABLE, 'UTM source', text(data.utm_source, 200), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'UTM medium', text(data.utm_medium, 200), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'UTM campaign', text(data.utm_campaign, 200), warnings);
  addField(fields, schema, OPERATORS_TABLE, 'Consentimiento privacidad', bool(data.privacyConsent), warnings);
  addDateField(fields, schema, OPERATORS_TABLE, 'Fecha solicitud portal', warnings);
  addDateField(fields, schema, OPERATORS_TABLE, 'Fecha Interaccion', warnings);
  addDateField(fields, schema, OPERATORS_TABLE, 'Fecha consentimiento', warnings);
  return fields;
}

function buildContactFields(data, operatorId, schema, existingRecord, warnings) {
  const fields = {};
  const existing = existingRecord?.fields || {};
  const comments = text(data.comments, 3000);
  const appendedNotes = appendBlock(existing['Notas'], `[Portal OPHAO SUBRA] ${new Date().toISOString()}`, [comments || 'Solicitud recibida desde formulario de acceso.']);
  addField(fields, schema, CONTACTS_TABLE, 'Nombre contacto', text(data.contactName, 200), warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Cargo', text(data.role, 200), warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Email', normalizeEmail(data.email), warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Telefono', text(data.phone, 80), warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Notas', appendedNotes, warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Operador', [operatorId], warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Idioma preferido', text(data.preferredLanguage || data.language, 10).toUpperCase(), warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Canal', 'Portal OPHAO SUBRA', warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Estado contacto', 'Nuevo', warnings);
  addField(fields, schema, CONTACTS_TABLE, 'Origen portal', 'OPHAO SUBRA Landing', warnings);
  addField(fields, schema, CONTACTS_TABLE, 'RGPD aceptado', bool(data.privacyConsent), warnings);
  addDateField(fields, schema, CONTACTS_TABLE, 'Fecha RGPD aceptado', warnings);
  return fields;
}

async function createOrUpdate(tableRef, recordId, fields) {
  const body = { fields, typecast: true };
  if (recordId) {
    return airtableFetch(`/${BASE_ID}/${encodeURIComponent(tableRef)}/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
  }
  return airtableFetch(`/${BASE_ID}/${encodeURIComponent(tableRef)}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function createInteraction(data, operatorId, contactId, schema, warnings) {
  const table = tableSchema(schema, INTERACTIONS_TABLE);
  if (schema.available && !table) {
    warnings.missingTable = warnings.missingTable || [];
    warnings.missingTable.push('Interacciones Portal');
    return null;
  }
  const requestTypes = [];
  if (bool(data.requestDataRoom)) requestTypes.push('Data Room requested');
  if (bool(data.requestNda)) requestTypes.push('NDA requested');
  if (bool(data.requestMeeting)) requestTypes.push('Meeting requested');
  if (!requestTypes.length) requestTypes.push('Access request');
  const fields = {};
  addField(fields, schema, INTERACTIONS_TABLE, 'Interaccion', `Access request · ${text(data.company, 120)} · ${new Date().toISOString()}`, warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'Operador', [operatorId], warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'Contacto', contactId ? [contactId] : undefined, warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'Tipo interaccion', requestTypes[0], warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'Pagina', '/ophao-subra/access', warnings);
  addDateField(fields, schema, INTERACTIONS_TABLE, 'Fecha interaccion', warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'Idioma', text(data.language, 10).toUpperCase(), warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'UTM source', text(data.utm_source, 200), warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'UTM medium', text(data.utm_medium, 200), warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'UTM campaign', text(data.utm_campaign, 200), warnings);
  addField(fields, schema, INTERACTIONS_TABLE, 'Notas', text(data.comments, 3000), warnings);
  try {
    return await createOrUpdate(INTERACTIONS_TABLE, null, fields);
  } catch (err) {
    console.warn('Interaction log skipped:', err.message);
    warnings.interactionLog = err.message;
    return null;
  }
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (!checkRateLimit(event)) return json(429, { ok: false, error: 'Too many requests. Please try again later.' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { ok: false, error: 'Invalid JSON payload.' });
  }

  // Honeypot anti-spam. Bots often fill hidden fields.
  if (text(data.website_field)) {
    return json(200, { ok: true, spam: true });
  }

  const email = normalizeEmail(data.email);
  const missingRequired = ['company', 'country', 'operatorType', 'contactName', 'interestModel', 'interestLevel'].filter(key => !required(data, key));
  if (!email || !validEmail(email)) missingRequired.push('email');
  if (!bool(data.privacyConsent)) missingRequired.push('privacyConsent');
  if (missingRequired.length) {
    return json(400, { ok: false, error: 'Missing or invalid required fields.', fields: missingRequired });
  }

  const warnings = { missingFields: [] };
  try {
    const schema = await getSchema();
    const existingOperator = await findOperator(data);
    const operatorFields = buildOperatorFields(data, schema, existingOperator, warnings);
    const operator = await createOrUpdate(OPERATORS_TABLE, existingOperator?.id, operatorFields);

    const existingContact = await findContact(email);
    const contactFields = buildContactFields(data, operator.id, schema, existingContact, warnings);
    const contact = await createOrUpdate(CONTACTS_TABLE, existingContact?.id, contactFields);

    await createInteraction(data, operator.id, contact.id, schema, warnings);

    return json(200, {
      ok: true,
      operatorId: operator.id,
      contactId: contact.id,
      operatorAction: existingOperator ? 'updated' : 'created',
      contactAction: existingContact ? 'updated' : 'created',
      warnings
    });
  } catch (err) {
    console.error('submit-access-request error:', err);
    return json(err.status || 500, {
      ok: false,
      error: err.message || 'Server error',
      details: err.payload || undefined
    });
  }
};
