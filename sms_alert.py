import os
import sys
import requests
from twilio.rest import Client
from dotenv import load_dotenv  # Import dotenv

# Load environment variables from .env file
load_dotenv()

# Twilio Credentials (Read from .env)
account_sid = os.getenv("TWILIO_SID")
auth_token = os.getenv("TWILIO_AUTH_TOKEN")

# Ensure credentials are loaded
if not account_sid or not auth_token:
    print("Error: Twilio credentials not set. Check your .env file.")
    sys.exit(1)

client = Client(account_sid, auth_token)

# Recipient phone number
to_number = "+917569546689"
from_number = "+14235221045"

# API endpoint where notifications data is available
api_url = "http://localhost:5000/notifications"

try:
    # Fetch notifications JSON data
    response = requests.get(api_url)
    response.raise_for_status()  # Raise an error if request fails

    # Parse JSON response
    expiring_products = response.json()

    # Check if there are any products near expiry
    if not expiring_products:
        print(" No products near expiry.")
    else:
        # Format the SMS message
        alert_message = " Expiry Alert:\n"
        for product in expiring_products:
            alert_message += f"{product['name']} (Expiry: {product['expiryDate']}, Stock: {product['stock']})\n"

        # Send SMS via Twilio
        message = client.messages.create(
            body=alert_message.strip(),
            from_=from_number,
            to=to_number
        )
        print(f" SMS sent! Message SID: {message.sid}")

except Exception as e:
    print(f" Error: {e}")
