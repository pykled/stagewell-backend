/**
 * HTML page served at /api/auth/gmail/callback
 * Handles the OAuth redirect and posts tokens back to the opener window
 */
export function getCallbackPageHTML(baseURL: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gmail Authorization</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
        }
        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        h1 {
            color: #333;
            margin: 0 0 10px 0;
            font-size: 24px;
        }
        p {
            color: #666;
            margin: 0;
            font-size: 14px;
        }
        .error {
            background: #ffebee;
            color: #c62828;
            padding: 15px;
            border-radius: 6px;
            margin-top: 20px;
            font-size: 14px;
        }
        .success {
            background: #e8f5e9;
            color: #2e7d32;
            padding: 15px;
            border-radius: 6px;
            margin-top: 20px;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="spinner"></div>
        <h1>Connecting Gmail...</h1>
        <p>Please wait while we securely connect your Gmail account.</p>
        <div id="status"></div>
    </div>

    <script>
        // Check if there's an error from Google
        const urlParams = new URLSearchParams(window.location.search);
        const error = urlParams.get('error');
        const code = urlParams.get('code');

        const statusEl = document.getElementById('status');

        if (error) {
            // OAuth denied or error
            document.querySelector('h1').textContent = 'Authorization Failed';
            document.querySelector('.spinner').style.display = 'none';
            statusEl.innerHTML = '<div class="error">Error: ' + error + '</div>';
            
            // Post error to parent window
            if (window.opener) {
                window.opener.postMessage({
                    type: 'GMAIL_AUTH_ERROR',
                    error: error
                }, '${baseURL}');
            }
            
            // Close after 3 seconds
            setTimeout(() => window.close(), 3000);
        } else if (code) {
            // Authorization successful, get tokens from our backend
            // The callback endpoint has already exchanged the code for tokens
            
            // Extract the authorization code result from the page
            // This will be injected by the backend after token exchange
            const tokenData = window.__GMAIL_TOKEN_DATA__;
            
            if (tokenData && tokenData.accessToken) {
                document.querySelector('h1').textContent = 'Gmail Connected!';
                document.querySelector('p').textContent = \`Authorized as: \${tokenData.email}\`;
                document.querySelector('.spinner').style.display = 'none';
                statusEl.innerHTML = '<div class="success">✓ You can now close this window</div>';
                
                // Post token to parent window
                if (window.opener) {
                    window.opener.postMessage({
                        type: 'GMAIL_AUTH_SUCCESS',
                        email: tokenData.email,
                        accessToken: tokenData.accessToken
                    }, '${baseURL}');
                }
                
                // Close after 2 seconds
                setTimeout(() => window.close(), 2000);
            }
        } else {
            // No authorization code - shouldn't happen
            document.querySelector('h1').textContent = 'Error';
            statusEl.innerHTML = '<div class="error">Invalid authorization response</div>';
            document.querySelector('.spinner').style.display = 'none';
            setTimeout(() => window.close(), 3000);
        }
    </script>
</body>
</html>
`;
}
