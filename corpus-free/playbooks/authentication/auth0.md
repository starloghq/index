# Auth0 migration playbook

- Create an Auth0 application and configure callback/logout URLs
- Install @auth0/nextjs-auth0 and set AUTH0_SECRET, CLIENT_ID, CLIENT_SECRET, ISSUER_BASE_URL
- Replace custom login/logout handlers with Auth0 route handlers
- Map roles/permissions to Auth0 RBAC or custom claims
- Delete custom session encryption and token refresh logic
- Update middleware to use Auth0 session helpers for route protection
- Rotate credentials that lived in DIY auth modules
