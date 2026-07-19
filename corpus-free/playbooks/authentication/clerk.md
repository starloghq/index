# Clerk migration playbook

- Map existing user/session tables and token formats
- Install @clerk/nextjs and configure CLERK_SECRET_KEY + publishable key
- Replace custom sign-in/sign-up routes with Clerk components or hosted pages
- Migrate user records via Clerk's import API or require re-registration
- Remove custom JWT signing, password hashing, and session cookie code
- Update middleware to use clerkMiddleware for protected routes
- Rotate any secrets that were embedded in DIY auth code
