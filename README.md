# University Consultancy form

- `index.html` - the consultant form (posts JSON to `/api/submit`)
- `api/` - Azure managed function that checks the answers and creates the Consultancy record and its child records in Salesforce
- `staticwebapp.config.json` - hosting settings (sign-in rules are added here once the Entra app registration exists)

Application settings (Static Web App > Environment variables): `SF_TOKEN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_API_VERSION` (optional, default v68.0). Never commit these.
