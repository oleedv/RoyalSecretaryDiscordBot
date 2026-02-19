// Settings loader — picks the right file based on NODE_ENV.
// Secrets (tokens, DB credentials) belong in .env / GitHub Secrets — not here.

const env = process.env.NODE_ENV || 'staging';

const { default: settings } = await import(`./settings.${env}.js`);

export default settings;
