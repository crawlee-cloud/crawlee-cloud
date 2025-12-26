/**
 * Setup functions for initial configuration.
 * Creates admin user from environment variables on first startup.
 */

import { nanoid } from 'nanoid';
import { pool } from './db/index.js';
import { hashPassword, createToken } from './auth/index.js';
import { config } from './config.js';

/**
 * Create admin user from environment variables if:
 * 1. ADMIN_EMAIL and ADMIN_PASSWORD are set
 * 2. No user with that email exists yet
 */
export async function setupAdminUser(): Promise<void> {
  const { adminEmail, adminPassword } = config;
  
  if (!adminEmail || !adminPassword) {
    console.log('[Setup] No ADMIN_EMAIL/ADMIN_PASSWORD set - skipping admin creation');
    return;
  }
  
  if (adminPassword.length < 8) {
    console.error('[Setup] ADMIN_PASSWORD must be at least 8 characters');
    return;
  }
  
  try {
    // Check if admin already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [adminEmail]
    );
    
    if (existing.rows.length > 0) {
      console.log(`[Setup] Admin user ${adminEmail} already exists`);
      return;
    }
    
    // Create admin user
    const userId = nanoid();
    const passwordHash = await hashPassword(adminPassword);
    
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, created_at) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, adminEmail, passwordHash, 'Admin', 'admin']
    );
    
    console.log(`[Setup] ✓ Admin user created: ${adminEmail}`);
  } catch (error) {
    console.error('[Setup] Failed to create admin user:', error);
  }
}
