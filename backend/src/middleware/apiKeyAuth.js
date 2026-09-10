/**
 * API Key Authentication Middleware
 * 
 * Validates X-Api-Key header against the API_KEY environment variable.
 * If API_KEY is not set or empty, authentication is skipped (open access).
 */

const apiKeyAuth = (req, res, next) => {
    const apiKey = process.env.API_KEY;
    
    // If no API key is configured, skip authentication
    if (!apiKey || apiKey === '' || apiKey === 'your_api_key_here') {
        return next();
    }
    
    const providedKey = req.headers['x-api-key'];
    
    if (!providedKey) {
        return res.status(401).json({
            success: false,
            message: 'Missing X-Api-Key header'
        });
    }
    
    if (providedKey !== apiKey) {
        return res.status(403).json({
            success: false,
            message: 'Invalid API key'
        });
    }
    
    next();
};

module.exports = apiKeyAuth;
