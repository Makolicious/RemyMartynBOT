/**
 * Telegram Table Formatter
 * Converts markdown tables to emoji-decorated text for Telegram display
 */

const TABLE_ICONS = {
  'Boss Profile': '👤',
  'Personality & Traits': '🧠',
  'Goals & Aspirations': '🎯',
  'Habits & Routines': '⏰',
  'Skills & Expertise': '⚡',
  'Friends & Contacts': '👥',
  'Family Members': '👨‍👩‍👧‍👦',
  'Business Associates': '💼',
  'Active Projects': '📁',
  'Business Ideas & Ventures': '💡',
  'Food & Drink Preferences': '🍽️',
  'Technology & Tools': '🛠️',
  'Entertainment Preferences': '🎬',
  'Work Style & Environment': '🏢',
  'Communication Style': '💬',
  'Travel & Places': '🌍',
  'Key Dates & Milestones': '📅',
  'Decisions & Commitments': '✅',
  'Pending Action Items': '📋',
  'Notes & Miscellaneous': '📝'
};

/**
 * Parse markdown tables from memory string
 * Returns array of { title, headers, rows }
 */
function parseTables(memory) {
  const tables = [];
  const lines = memory.split('\n');
  let currentTable = null;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Table header (starts with |)
    if (line.match(/^\|.+?\|/)) {
      if (!currentTable) {
        // New table - get title from previous line
        const titleLine = lines[i - 1] || '';
        const titleMatch = titleLine.match(/^##?\s*(.+)/);
        currentTable = {
          title: titleMatch ? titleMatch[1].trim() : 'Table',
          headers: parseTableRow(line),
          rows: []
        };
      } else if (!line.match(/^\|[-|\s]+\|$/)) {
        // Skip separator row, add data row
        const row = parseTableRow(line);
        if (row.length === currentTable.headers.length) {
          currentTable.rows.push(row);
        }
      }
    } else if (currentTable) {
      // End of table
      if (currentTable.rows.length > 0) {
        tables.push(currentTable);
      }
      currentTable = null;
    }
  }

  // Don't forget the last table
  if (currentTable && currentTable.rows.length > 0) {
    tables.push(currentTable);
  }

  return tables;
}

/**
 * Parse a single table row (remove pipes, trim cells)
 */
function parseTableRow(line) {
  return line.split('|')
    .map(cell => cell.trim())
    .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1); // Skip empty first/last
}

/**
 * Get emoji icon for table title
 */
function getTableIcon(title) {
  return TABLE_ICONS[title] || '📊';
}

/**
 * Format a table for Telegram display
 */
function formatTable(table) {
  if (!table || !table.rows || table.rows.length === 0) {
    return '';
  }

  const icon = getTableIcon(table.title);
  const lines = [`${icon} ${table.title}`];
  lines.push('┌' + '─'.repeat(45) + '┐');

  // Format each row
  for (const row of table.rows) {
    // Skip rows with all placeholders like [Field] or ---
    const isEmpty = row.every(cell =>
      cell.match(/^\[.*?\]$/) || cell === '' || cell === '---'
    );
    if (isEmpty) continue;

    const formattedRow = formatTableRow(row, table.headers);
    lines.push(`│ ${formattedRow.padEnd(43)}│`);
  }

  lines.push('└' + '─'.repeat(45) + '┘');
  return lines.join('\n');
}

/**
 * Format a single table row for display
 */
function formatTableRow(row, headers) {
  if (headers.length >= 4) {
    // Multi-column table: show first 3 columns with bullet
    const cells = row.slice(0, 3).map(cell => truncateCell(cell, 12));
    return `▫️ ${cells.join('  •  ')}`;
  } else if (headers.length >= 2) {
    // Two-column table
    return `${row[0]}: ${row.slice(1).join(' ')}`;
  }
  return row.join(' ');
}

/**
 * Truncate cell if too long
 */
function truncateCell(cell, maxLength) {
  if (cell.length <= maxLength) return cell;
  return cell.substring(0, maxLength - 2) + '..';
}

/**
 * Format entire memory for Telegram
 * Options: { paginate: boolean, sections: string[], limit: number }
 */
function formatMemoryForTelegram(memory, options = {}) {
  const tables = parseTables(memory);

  if (tables.length === 0) {
    return '📊 No memory data found.';
  }

  let result = '';

  // Filter by sections if specified
  let displayTables = tables;
  if (options.sections && options.sections.length > 0) {
    displayTables = tables.filter(t =>
      options.sections.some(s => t.title.toLowerCase().includes(s.toLowerCase()))
    );
  }

  // Limit number of tables
  const limit = options.limit || displayTables.length;
  displayTables = displayTables.slice(0, limit);

  // Format each table
  for (const table of displayTables) {
    const formatted = formatTable(table);
    if (formatted) {
      result += formatted + '\n\n';
    }
  }

  if (options.limit && tables.length > limit) {
    result += `\n... and ${tables.length - limit} more sections.\n`;
    result += `Use /memory view [section] to see specific sections.`;
  }

  return result.trim() || '📊 No memory data to display.';
}

module.exports = {
  formatMemoryForTelegram,
  parseTables,
  formatTable
};
