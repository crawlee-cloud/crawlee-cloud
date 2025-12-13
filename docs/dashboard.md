# Dashboard

The Crawlee Cloud Dashboard provides a web interface for managing your Actors and runs.

## Features

### Home

Overview of your account:
- Recent runs
- Actor statistics
- System status

### Actors

Manage your Actors:
- View all Actors
- Create new Actors
- View Actor details and runs

### Runs

Monitor Actor executions:
- View run status
- Stream logs in real-time
- View run output

### Datasets

Browse scraped data:
- List all datasets
- View dataset items
- Export data

### Settings

Configure your account:
- API tokens
- Server settings
- User preferences

## Accessing the Dashboard

The dashboard runs on port 3001 by default:

```
http://localhost:3001
```

## Authentication

Login with your API token or create a new account on the register page.

## Real-time Logs

The dashboard uses WebSocket connections to stream logs in real-time. Click on any run to see live output.

## Dark Mode

Toggle dark mode using the theme switcher in the header.
