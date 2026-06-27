OPHAO SUBRA - Phase 2B Netlify deployment
=========================================

This package adds:
- /ophao-subra/access/ access request form in ES/EN
- /ophao-subra/book-call/ redirect to access form with meeting preselected
- /ophao-subra/data-room/ redirect to access form with Data Room preselected
- Netlify Function: /.netlify/functions/submit-access-request
- netlify.toml with function directory configuration

Required Netlify environment variables
--------------------------------------
Set these in Netlify > Site configuration > Environment variables:

1) AIRTABLE_TOKEN
Personal Access Token from Airtable.
Required scopes:
- data.records:read
- data.records:write
Recommended additional scope:
- schema.bases:read

2) AIRTABLE_BASE_ID
appNv17eklqxUMQIy

Optional variables:
- AIRTABLE_OPERATORS_TABLE_ID = tblHrWysOvgHlOgd5
- AIRTABLE_CONTACTS_TABLE_ID = tbl6Bi3TK5wRlZkUa
- AIRTABLE_INTERACTIONS_TABLE_ID = Interacciones Portal or the table ID if created

Important Airtable prerequisite
-------------------------------
Before using the form in production, complete Phase 2A in Airtable:
- Rename field "Hecho" to "NDA recibido firmado" if appropriate.
- Create all portal-specific fields in Operadores Objetivo.
- Create portal-specific fields in Contactos Operadores.
- Create Interacciones Portal table.

The function is defensive: if schema.bases:read is available, it detects missing optional fields and skips them instead of breaking the whole submission. Still, for full CRM tracking, Phase 2A should be completed first.

How to test after deployment
----------------------------
1) Open /ophao-subra/access
2) Submit a test lead using an email you can identify.
3) Check Airtable > Operadores Objetivo:
   - New/updated operator
   - Estado Pipeline according to request priority
   - Fecha Interaccion updated
   - Portal fields completed
4) Check Airtable > Contactos Operadores:
   - New/updated contact
   - Linked to operator
5) Check Airtable > Interacciones Portal:
   - Interaction log created, if table exists

Request priority
----------------
1) Discovery call -> Estado Pipeline = Contactado, Proxima accion = Llamar
2) NDA -> Estado Pipeline = Contactado, Proxima accion = Enviar NDA
3) Data Room -> Estado Pipeline = Enviar Info, Proxima accion = Enviar informacion, Preparado automatizacion = checked
4) Lead simple -> Estado Pipeline = Lead, Proxima accion = Enviar informacion

Security notes
--------------
- Airtable token is only used server-side in the Netlify Function.
- The token is not present in browser JavaScript.
- Honeypot anti-spam is included.
- Basic in-memory rate limiting is included.
- Required fields and privacy consent are validated server-side.
