<script>
  import '../app.css';
  import { page } from '$app/stores';
</script>

<div class="app-shell">
  <div class="topbar">
    <a href="/" class="logo">DILL<span class="accent">·</span>DINKERS</a>
    <nav>
      <a href="/" class:active={$page.url.pathname === '/'}>Leagues</a>
    </nav>
  </div>
  <main class="app-main">
    <slot />
  </main>
  <footer class="appfoot">
    Dill Dinkers Pickleball &middot; Live league standings &middot; Updated from the operator console
  </footer>
</div>
