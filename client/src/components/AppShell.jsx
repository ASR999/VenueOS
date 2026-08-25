import { useState } from 'react';
import { resolveTheme, setTheme } from '../theme.js';

// The app chrome. Deliberately full-bleed: the header spans the whole viewport
// and only its *contents* are constrained, which is what makes a page read as an
// application rather than a document floating in the middle of the screen.
export default function AppShell({ user, view, onNavigate, onSignOut, children }) {
  const [theme, setThemeState] = useState(resolveTheme);

  function toggleTheme() {
    setThemeState(setTheme(theme === 'dark' ? 'light' : 'dark'));
  }

  return (
    <div className="bg-canvas text-ink flex min-h-dvh flex-col">
      <header className="border-line app-header sticky top-0 z-40 border-b">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-6 px-4 sm:px-6">
          <button
            onClick={() => onNavigate('events')}
            className="flex shrink-0 cursor-pointer items-center gap-2.5"
          >
            <span
              className="grid size-7 place-items-center rounded-lg text-[13px]"
              style={{ background: 'var(--grad-brand)' }}
            >
              🎟️
            </span>
            <span className="text-[15px] font-semibold tracking-tight">VenueOS</span>
          </button>

          {user && (
            <nav className="hidden items-center gap-1 sm:flex">
              <NavLink active={view === 'events'} onClick={() => onNavigate('events')}>
                Events
              </NavLink>
              <NavLink active={view === 'bookings'} onClick={() => onNavigate('bookings')}>
                My bookings
              </NavLink>
            </nav>
          )}

          <div className="flex-1" />

          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label="Toggle theme"
            className="btn btn-quiet size-9 !px-0"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>

          {user && (
            <div className="flex items-center gap-3">
              <span
                className="text-muted hidden max-w-[200px] truncate text-sm md:block"
                title={user.email}
              >
                {user.email}
              </span>
              <button onClick={onSignOut} className="btn btn-ghost !py-1.5">
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>

      <footer className="border-line text-faint border-t px-6 py-4 text-center text-xs">
        VenueOS 
      </footer>
    </div>
  );
}

function NavLink({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-canvas text-ink' : 'text-muted hover:text-ink hover:bg-canvas'
      }`}
    >
      {children}
    </button>
  );
}
