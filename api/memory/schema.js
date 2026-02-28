/**
 * Self-Organizing Memory Schema
 * Defines the structure and validation for memory entries
 */

const CATEGORIES = [
  'Boss Profile',
  'Personality & Traits',
  'Goals & Aspirations',
  'Habits & Routines',
  'Skills & Expertise',
  'Friends & Contacts',
  'Family Members',
  'Business Associates',
  'Active Projects',
  'Business Ideas & Ventures',
  'Food & Drink Preferences',
  'Technology & Tools',
  'Entertainment Preferences',
  'Work Style & Environment',
  'Communication Style',
  'Travel & Places',
  'Key Dates & Milestones',
  'Decisions & Commitments',
  'Pending Action Items',
  'Notes & Miscellaneous'
];

const DEFAULT_DECAY_RATES = {
  'Boss Profile': 0.98,
  'Personality & Traits': 0.97,
  'Goals & Aspirations': 0.96,
  'Habits & Routines': 0.95,
  'Skills & Expertise': 0.97,
  'Friends & Contacts': 0.95,
  'Family Members': 0.98,
  'Business Associates': 0.94,
  'Active Projects': 0.93,
  'Business Ideas & Ventures': 0.90,
  'Food & Drink Preferences': 0.94,
  'Technology & Tools': 0.92,
  'Entertainment Preferences': 0.90,
  'Work Style & Environment': 0.96,
  'Communication Style': 0.96,
  'Travel & Places': 0.94,
  'Key Dates & Milestones': 0.92,
  'Decisions & Commitments': 0.93,
  'Pending Action Items': 0.91,
  'Notes & Miscellaneous': 0.88
};

const DEFAULT_IMPORTANCE_BY_CATEGORY = {
  'Boss Profile': 100,
  'Personality & Traits': 90,
  'Goals & Aspirations': 95,
  'Habits & Routines': 85,
  'Skills & Expertise': 80,
  'Friends & Contacts': 75,
  'Family Members': 85,
  'Business Associates': 70,
  'Active Projects': 90,
  'Business Ideas & Ventures': 80,
  'Food & Drink Preferences': 60,
  'Technology & Tools': 65,
  'Entertainment Preferences': 55,
  'Work Style & Environment': 80,
  'Communication Style': 75,
  'Travel & Places': 60,
  'Key Dates & Milestones': 85,
  'Decisions & Commitments': 80,
  'Pending Action Items': 95,
  'Notes & Miscellaneous': 50
};

/**
 * Generate a unique memory ID
 */
function generateId() {
  return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a new memory entry
 */
function createMemory(content, category, confidence = 80, pinned = false) {
  const id = generateId();
  const now = Date.now();

  return {
    id,
    content,
    category: normalizeCategory(category),
    importance: DEFAULT_IMPORTANCE_BY_CATEGORY[category] || 70,
    confidence: Math.min(100, Math.max(0, confidence)),
    created_at: now,
    last_accessed: now,
    access_count: 0,
    decay_rate: DEFAULT_DECAY_RATES[category] || 0.95,
    related_ids: [],
    pinned: pinned  // AI can mark important facts as permanent (no decay)
  };
}

/**
 * Normalize category to valid value
 */
function normalizeCategory(category) {
  if (!category) return 'Notes & Miscellaneous';

  const normalized = CATEGORIES.find(c =>
    c.toLowerCase().includes(category.toLowerCase())
  );

  return normalized || 'Notes & Miscellaneous';
}

/**
 * Validate memory entry
 */
function validateMemory(memory) {
  const errors = [];

  if (!memory.id || typeof memory.id !== 'string') {
    errors.push('Invalid or missing id');
  }

  if (!memory.content || typeof memory.content !== 'string') {
    errors.push('Invalid or missing content');
  }

  if (!memory.category || !CATEGORIES.includes(memory.category)) {
    errors.push('Invalid category');
  }

  if (typeof memory.importance !== 'number' || memory.importance < 0 || memory.importance > 100) {
    errors.push('Invalid importance (must be 0-100)');
  }

  if (typeof memory.confidence !== 'number' || memory.confidence < 0 || memory.confidence > 100) {
    errors.push('Invalid confidence (must be 0-100)');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  CATEGORIES,
  DEFAULT_DECAY_RATES,
  DEFAULT_IMPORTANCE_BY_CATEGORY,
  generateId,
  createMemory,
  normalizeCategory,
  validateMemory
};
