// public/js/theme.js - BionFiber Unified Theme Switcher

function applyAppTheme(theme) {
  const isLight = (theme === 'light');
  
  // Set data-theme attribute on root
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  
  // Toggle .light-theme class on both html and body
  if (isLight) {
    document.documentElement.classList.add('light-theme');
    if (document.body) document.body.classList.add('light-theme');
  } else {
    document.documentElement.classList.remove('light-theme');
    if (document.body) document.body.classList.remove('light-theme');
  }

  updateThemeToggleIcons(theme);
}

function toggleAppTheme() {
  const current = localStorage.getItem('app-theme') || 
                  document.documentElement.getAttribute('data-theme') || 
                  (document.documentElement.classList.contains('light-theme') ? 'light' : 'dark');
  const newTheme = (current === 'light') ? 'dark' : 'light';
  
  try {
    localStorage.setItem('app-theme', newTheme);
  } catch (e) {
    console.error('Failed to save theme in localStorage', e);
  }
  
  applyAppTheme(newTheme);
}

function updateThemeToggleIcons(theme) {
  const isLight = (theme === 'light');
  document.querySelectorAll('.theme-toggle-icon').forEach(icon => {
    icon.className = isLight ? 'bi bi-sun-fill theme-toggle-icon' : 'bi bi-moon-stars-fill theme-toggle-icon';
    icon.style.color = isLight ? '#f59e0b' : '#38bdf8';
  });
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.setAttribute('title', isLight ? 'Ganti ke Mode Gelap (Dark)' : 'Ganti ke Mode Terang (Light)');
  });
}

// Immediate run
(function() {
  try {
    const saved = localStorage.getItem('app-theme') || 'dark';
    applyAppTheme(saved);
  } catch (e) {}
})();

// Re-apply when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  try {
    const saved = localStorage.getItem('app-theme') || 'dark';
    applyAppTheme(saved);
  } catch (e) {}
});

// Expose globally
window.applyAppTheme = applyAppTheme;
window.toggleAppTheme = toggleAppTheme;
window.updateThemeToggleIcons = updateThemeToggleIcons;
