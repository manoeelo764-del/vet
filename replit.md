# VetCare License Server

## Overview

VetCare License Server is a license management system for the VetCare veterinary practice management software. It provides a complete solution for creating, validating, and tracking software licenses with device fingerprinting capabilities. The system includes an admin dashboard for managing licenses and monitoring device usage.

Key features:
- License creation with customizable validity periods
- License verification with device tracking
- Admin dashboard with RTL (Arabic) interface support
- Device fingerprinting to track which devices use each license
- Usage statistics and analytics

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Architecture
- **Runtime**: Node.js with Express.js framework
- **Pattern**: RESTful API with JSON data format
- **Entry Point**: `server.js` - Main server file handling all API routes

### Data Storage
- **Approach**: File-based JSON storage (`licenses.json`)
- **Rationale**: Simple deployment without database dependencies; suitable for small-scale license management
- **Trade-offs**: Not ideal for high concurrency or large datasets, but sufficient for license management use case

### Frontend Architecture
- **Type**: Static single-page application
- **Location**: `/public` directory
- **Components**:
  - `index.html` - Main dashboard interface (RTL Arabic layout)
  - `script.js` - Client-side JavaScript for dashboard interactivity
  - `styles.css` - Custom styling with CSS variables

### API Structure
Key endpoints:
- `POST /api/licenses` - Create new license
- `POST /api/verify-license` - Verify license and track device
- `GET /api/licenses/:hash/devices` - Get device usage data for a license

### Device Tracking System
- Tracks device fingerprints per license
- Records OS, browser/app type, first use, last use, and usage count
- Enables license usage monitoring and potential abuse detection

### Security Considerations
- License keys use SHA-256 hashing for storage
- Device fingerprinting for usage tracking
- CORS configuration for API access control

## External Dependencies

### NPM Packages
- **express** (^4.18.2) - Web server framework
- **cors** (^2.8.5) - Cross-Origin Resource Sharing middleware
- **dotenv** (^16.3.1) - Environment variable management
- **axios** (^1.6.0) - HTTP client for external requests
- **nodemon** (^3.0.2) - Development auto-restart utility

### Development Dependencies
- **cross-env** (^7.0.3) - Cross-platform environment variable setting

### External Services
- None currently integrated; operates as standalone server

### Database
- No external database; uses local JSON file storage
- Consider migrating to PostgreSQL with Drizzle ORM for production scaling