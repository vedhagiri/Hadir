# Animation polish — Linear / Vercel level feel

**Status:** Pre-Omran polish phase. Optional but high-impact.

**Why now:** Hadir works correctly after P28.5/.6/.7/.8. What's missing is the *feel* — the small-scale animations that separate "functional SaaS" from "premium SaaS." This phase doesn't add features; it adds craft.

**Decisions locked:**
- Sidebar: subtle hover + active-indicator slide between items. **No entrance animation** on app load.
- Overall level: highly polished, Linear/Vercel feel. List staggers, page transitions, button feedback, number rolls, toasts.
- Reduced-motion: **partial respect.** Page transitions and list staggers honor `prefers-reduced-motion`. Hover effects, button feedback, active indicator slides stay on always (short and don't trigger vestibular issues).

**Library:** Framer Motion. ~40KB gzipped. Standard for this kind of work in React.

**Estimated time:** 8–10 hours.

---

## Pre-flight

- Drawer positioning fix is committed (the prior prompt). Animations build on top of correctly-portaled drawers.
- All P28.5/.6/.7/.8 phases signed off.
- `git status` clean.

---

## The prompt to paste into Claude Code

> You are working on Hadir polish phase. The product works correctly. This phase adds Linear/Vercel-level animation polish. Do not change any behavior — only add motion.
>
> Read these before writing anything:
>
> 1. `CLAUDE.md`
> 2. `design-reference/styles.css` and `design-reference/pages.jsx` — for any motion tokens or hints (`--motion-fast`, easing functions, etc.)
> 3. `frontend/src/shell/` — sidebar, layout, route transitions wrapper if any
> 4. `frontend/src/pages/` — observe the page structure across Dashboard, Employees, Calendar, Live Capture so the route transition wrapper handles all of them
> 5. `frontend/package.json` — confirm framer-motion is not already installed
>
> Then implement the polish layer below.
>
> ### Library setup
>
> Add framer-motion:
> ```bash
> npm install framer-motion
> ```
>
> ### Motion tokens (define once, use everywhere)
>
> Create or extend `frontend/src/motion/tokens.ts`:
> ```ts
> export const DURATION = {
>   instant: 0.1,
>   fast: 0.15,
>   normal: 0.2,
>   slow: 0.3,
>   slower: 0.4,
> } as const;
>
> export const EASING = {
>   // Linear's signature smooth ease — emphasis on out, gentle on in
>   smooth: [0.4, 0.0, 0.2, 1] as const,
>   // For things that need to feel snappy (button presses)
>   snappy: [0.5, 0.0, 0.2, 1] as const,
>   // For entrance animations
>   entrance: [0.0, 0.0, 0.2, 1] as const,
>   // For exit animations
>   exit: [0.4, 0.0, 1.0, 1] as const,
> } as const;
>
> export const SPRING = {
>   gentle: { type: "spring", stiffness: 300, damping: 30 } as const,
>   bouncy: { type: "spring", stiffness: 400, damping: 17 } as const,
>   stiff: { type: "spring", stiffness: 500, damping: 35 } as const,
> } as const;
> ```
>
> Use these tokens in every animation. Never hardcode duration/easing inline. This is what lets you tune the whole app's feel from one file later.
>
> ### Reduced-motion handling
>
> Create `frontend/src/motion/useReducedMotion.ts` (Framer Motion has a hook called `useReducedMotion` already — use that directly, but wrap it in a project-level helper):
>
> ```ts
> import { useReducedMotion as useFmReducedMotion } from 'framer-motion';
>
> /**
>  * Returns true if the user has prefers-reduced-motion set.
>  *
>  * Hadir's animation policy (compromise tier):
>  * - Page transitions and list staggers: DISABLED when this returns true
>  * - Hover effects, button feedback, active-indicator slide: ALWAYS on
>  *   (short and don't trigger vestibular issues)
>  * - Drawer slide-in: shortened duration but kept (the slide is part of
>  *   the spatial model — without it the drawer just appears, confusingly)
>  */
> export function useReducedMotion(): boolean {
>   return useFmReducedMotion() ?? false;
> }
> ```
>
> Add this CSS at the top of the global stylesheet for the few CSS-only animations that exist:
>
> ```css
> @media (prefers-reduced-motion: reduce) {
>   /* Disable page-transition CSS animations only.
>      Component-level animations are governed by useReducedMotion() in JS. */
>   .page-transition-fade,
>   .list-stagger-item {
>     animation: none !important;
>     transition: none !important;
>   }
> }
> ```
>
> ### Page transitions
>
> Route changes get a fade + slight upward slide. Outgoing page fades out (150ms), new page fades in with 8px upward slide (200ms). They overlap by ~50ms so the navigation doesn't feel slow.
>
> Wrap the route outlet with AnimatePresence:
>
> ```tsx
> // In the Layout / shell component, around the <Outlet /> or page renderer
> import { AnimatePresence, motion } from 'framer-motion';
> import { useLocation } from 'react-router-dom';
> import { useReducedMotion } from '@/motion/useReducedMotion';
> import { DURATION, EASING } from '@/motion/tokens';
>
> function PageTransition({ children }: { children: React.ReactNode }) {
>   const location = useLocation();
>   const reduce = useReducedMotion();
>
>   if (reduce) {
>     return <>{children}</>;
>   }
>
>   return (
>     <AnimatePresence mode="wait">
>       <motion.div
>         key={location.pathname}
>         initial={{ opacity: 0, y: 8 }}
>         animate={{ opacity: 1, y: 0 }}
>         exit={{ opacity: 0, y: -8 }}
>         transition={{ duration: DURATION.normal, ease: EASING.smooth }}
>       >
>         {children}
>       </motion.div>
>     </AnimatePresence>
>   );
> }
> ```
>
> Place this around the route render area in the shell. Watch for: the wrapper must NOT be inside a route — it has to wrap the route render area so AnimatePresence can detect the route change.
>
> ### Sidebar hover + active indicator slide
>
> Two pieces:
>
> 1. **Hover state.** Each sidebar item gets a subtle background shift on hover. CSS only:
>    ```css
>    .sidebar__item {
>      transition: background-color 120ms ease-out, color 120ms ease-out;
>    }
>    .sidebar__item:hover {
>      background: var(--surface-hover);
>    }
>    ```
>
> 2. **Active indicator slide.** A small bar (4px wide, full item height) sits at the left edge of the active item. When the user clicks a different item, the bar **slides** to the new item rather than disappearing-and-reappearing.
>
>    Implementation pattern using Framer Motion's `layoutId`:
>    ```tsx
>    {items.map(item => (
>      <Link key={item.path} to={item.path} className="sidebar__item">
>        {item.path === activePath && (
>          <motion.div
>            className="sidebar__active-indicator"
>            layoutId="sidebarActive"
>            transition={{ type: "spring", stiffness: 400, damping: 30 }}
>          />
>        )}
>        <Icon name={item.icon} />
>        <span>{item.label}</span>
>      </Link>
>    ))}
>    ```
>
>    Framer Motion's `layoutId` is the magic — when the active item changes, Framer animates the indicator from its old position to its new position automatically. This is the single highest-impact animation in the whole app. Get this right and it elevates the whole feel.
>
>    CSS for the indicator:
>    ```css
>    .sidebar__active-indicator {
>      position: absolute;
>      left: 0;
>      top: 4px;
>      bottom: 4px;
>      width: 3px;
>      background: var(--accent);
>      border-radius: 0 2px 2px 0;
>    }
>    ```
>
>    The active-indicator slide always plays — even with reduced-motion. It's short (~250ms), spatial (helps user track where the active state went), and doesn't trigger vestibular issues.
>
> ### List stagger (tables, cards, menu items)
>
> Table rows fade in with 30ms stagger between each. Caps at 12 items — beyond that, all remaining rows appear instantly to avoid feeling slow. Reduced-motion turns this off entirely.
>
> Generic helper component `frontend/src/motion/StaggeredList.tsx`:
>
> ```tsx
> import { motion } from 'framer-motion';
> import { DURATION, EASING } from '@/motion/tokens';
> import { useReducedMotion } from '@/motion/useReducedMotion';
>
> interface StaggeredListProps {
>   children: React.ReactNode[];
>   className?: string;
>   staggerDelay?: number;  // ms between items
>   maxStaggered?: number;  // beyond this index, no delay
>   as?: React.ElementType;  // 'div' | 'tbody' | 'ul' etc.
> }
>
> export function StaggeredList({
>   children,
>   className,
>   staggerDelay = 30,
>   maxStaggered = 12,
>   as: Component = 'div',
> }: StaggeredListProps) {
>   const reduce = useReducedMotion();
>
>   return (
>     <Component className={className}>
>       {React.Children.map(children, (child, index) => {
>         const delay = reduce ? 0 : Math.min(index, maxStaggered) * (staggerDelay / 1000);
>
>         return (
>           <motion.div
>             initial={reduce ? false : { opacity: 0, y: 6 }}
>             animate={{ opacity: 1, y: 0 }}
>             transition={{
>               duration: reduce ? 0 : DURATION.normal,
>               ease: EASING.smooth,
>               delay,
>             }}
>           >
>             {child}
>           </motion.div>
>         );
>       })}
>     </Component>
>   );
> }
> ```
>
> Apply to: Employees list rows, Camera Logs rows, Approvals queue items, Calendar day cells, any other list-of-cards layouts.
>
> Skip for: dropdowns (open instantly), inline form fields (don't want jumpy forms).
>
> ### Skeleton → content crossfade
>
> Currently TanStack Query loading states snap from skeleton to content. Add a brief crossfade.
>
> Pattern:
> ```tsx
> {isLoading ? (
>   <motion.div
>     key="skeleton"
>     initial={{ opacity: 0 }}
>     animate={{ opacity: 1 }}
>     exit={{ opacity: 0 }}
>     transition={{ duration: DURATION.fast }}
>   >
>     <SkeletonRows count={5} />
>   </motion.div>
> ) : (
>   <motion.div
>     key="content"
>     initial={{ opacity: 0 }}
>     animate={{ opacity: 1 }}
>     transition={{ duration: DURATION.normal, delay: DURATION.fast }}
>   >
>     <ActualContent />
>   </motion.div>
> )}
> ```
>
> Wrap in `<AnimatePresence mode="wait">` so the skeleton fully exits before content enters.
>
> Apply consistently across pages that use TanStack Query: Employees, Cameras, Camera Logs, Calendar, Live Capture stats, Worker monitoring, Approvals.
>
> ### Button hover + click feedback
>
> Two pieces:
>
> 1. **Hover lift.** Primary buttons gain a 1px upward shift on hover. CSS only:
>    ```css
>    .btn {
>      transition: transform 120ms ease-out, box-shadow 120ms ease-out;
>    }
>    .btn:hover {
>      transform: translateY(-1px);
>      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
>    }
>    .btn:active {
>      transform: translateY(0);
>      transition: transform 50ms ease-out;
>    }
>    ```
>
> 2. **Async button loading state.** When a button triggers an async action (Save, Delete, Submit, Restart Worker), it shows an inline spinner and is disabled until the action completes. Existing buttons across the app should adopt this pattern. If a Button component already exists, extend it; if not, create one.
>
>    ```tsx
>    interface ButtonProps {
>      children: React.ReactNode;
>      onClick?: () => void | Promise<void>;
>      variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
>      isLoading?: boolean;
>      disabled?: boolean;
>      type?: 'button' | 'submit';
>    }
>
>    export function Button({ children, onClick, isLoading, ...props }: ButtonProps) {
>      const [internalLoading, setInternalLoading] = useState(false);
>      const loading = isLoading || internalLoading;
>
>      const handleClick = async () => {
>        if (!onClick) return;
>        const result = onClick();
>        if (result instanceof Promise) {
>          setInternalLoading(true);
>          try {
>            await result;
>          } finally {
>            setInternalLoading(false);
>          }
>        }
>      };
>
>      return (
>         <button
>           {...props}
>           onClick={handleClick}
>           disabled={loading || props.disabled}
>           className={cn('btn', `btn--${props.variant ?? 'primary'}`, loading && 'btn--loading')}
>         >
>           {loading && <Spinner size={14} />}
>           <span style={{ opacity: loading ? 0.6 : 1 }}>{children}</span>
>         </button>
>      );
>    }
>    ```
>
>    Audit the existing Button usage; migrate forms to use this pattern. Don't migrate every button at once — prioritize Save/Submit/Delete/Restart actions where the wait matters.
>
> ### Number rolling
>
> When a counter changes (active employees: 105 → 106, detections last 10m: 47 → 48), animate the digits rolling instead of snapping. Polish detail.
>
> Use Framer Motion's `useSpring` + `useTransform`:
>
> ```tsx
> import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
> import { useEffect } from 'react';
>
> interface RollingNumberProps {
>   value: number;
>   format?: (n: number) => string;
> }
>
> export function RollingNumber({ value, format = (n) => Math.round(n).toString() }: RollingNumberProps) {
>   const motionValue = useMotionValue(value);
>   const spring = useSpring(motionValue, { stiffness: 100, damping: 30 });
>   const display = useTransform(spring, format);
>
>   useEffect(() => { motionValue.set(value); }, [value, motionValue]);
>
>   return <motion.span>{display}</motion.span>;
> }
> ```
>
> Apply to: Live Capture stats (Detections last 10m: 47, Known 44, Unknown 3), Worker monitoring counters, Dashboard summary numbers.
>
> Don't apply to: prices, IDs, dates, anything where a wrong intermediate value would be confusing.
>
> ### Toast notification system
>
> If a toast/snackbar system already exists, polish its animation. If not, build one minimally.
>
> Toast slides in from top-right (300ms ease-out), shows for 4 seconds with a thin progress bar across the bottom that depletes, slides out (200ms ease-in).
>
> Use `frontend/src/shell/Toaster.tsx`:
>
> ```tsx
> import { motion, AnimatePresence } from 'framer-motion';
>
> // Single global toast container, mounted at app root
> // Toasts triggered via showToast({ message, variant }) helper
>
> // Toast component:
> <motion.div
>   initial={{ opacity: 0, x: 100 }}
>   animate={{ opacity: 1, x: 0 }}
>   exit={{ opacity: 0, x: 100 }}
>   transition={{ duration: DURATION.normal, ease: EASING.smooth }}
>   className={`toast toast--${variant}`}
> >
>   <div className="toast__content">{message}</div>
>   <motion.div
>     className="toast__progress"
>     initial={{ scaleX: 1 }}
>     animate={{ scaleX: 0 }}
>     transition={{ duration: 4, ease: 'linear' }}
>   />
> </motion.div>
> ```
>
> Variants: success, error, warning, info. Each gets a different left-border color.
>
> Trigger: `import { toast } from '@/shell/Toaster'; toast.success('Employee updated')` or similar API.
>
> Use across the app where currently silent success/error happens: form submits, restarts, photo uploads, settings changes.
>
> ### Drawer entrance animation
>
> Drawer already slides in from right (from the prior fix). Verify it's using `framer-motion` now instead of CSS keyframes — easier to coordinate with reduced-motion.
>
> ```tsx
> <motion.div
>   className="drawer"
>   initial={{ x: '100%' }}
>   animate={{ x: 0 }}
>   exit={{ x: '100%' }}
>   transition={{
>     duration: reduce ? 0.1 : DURATION.slow,
>     ease: EASING.smooth,
>   }}
> >
>   ...
> </motion.div>
> ```
>
> Backdrop fades in/out:
> ```tsx
> <motion.div
>   className="drawer-overlay"
>   initial={{ opacity: 0 }}
>   animate={{ opacity: 1 }}
>   exit={{ opacity: 0 }}
>   transition={{ duration: DURATION.fast }}
> >
> ```
>
> ### Where NOT to add animation
>
> - Form field focus states — keep CSS-only outline transitions, no Framer Motion overhead
> - Tooltips — keep instant or near-instant CSS transitions
> - Tab switches inside settings pages — instant, animation feels slow for repeated switches
> - Cell value updates in tables that update on poll (Workers page) — number rolls only, the row itself doesn't re-animate
> - Login screen — login is a moment of friction; animation makes it slower not faster
>
> ### Files to commit
>
> - `frontend/package.json` — add framer-motion
> - `frontend/src/motion/tokens.ts` — new
> - `frontend/src/motion/useReducedMotion.ts` — new
> - `frontend/src/motion/StaggeredList.tsx` — new
> - `frontend/src/motion/RollingNumber.tsx` — new
> - `frontend/src/motion/PageTransition.tsx` — new
> - `frontend/src/shell/` — sidebar with active indicator, layout with PageTransition wrapper
> - `frontend/src/components/Button.tsx` — extend with async loading
> - `frontend/src/components/Drawer.tsx` — port to Framer Motion
> - `frontend/src/shell/Toaster.tsx` — new (or polish existing)
> - `frontend/src/index.css` (or wherever globals live) — add reduced-motion CSS block
> - All consumer pages — opt into StaggeredList for tables, RollingNumber for counters, Toaster for success/error feedback
>
> ---
>
> ### 🚦 VALIDATION MILESTONE
>
> #### Setup
> 1. `npm install` (picks up framer-motion)
> 2. Restart frontend dev server
>
> #### Page transitions
> 3. Click between Dashboard → Employees → Calendar in sidebar. Each transition fades the outgoing page out and fades the new page in with a slight upward slide. Total time per transition feels under 300ms.
> 4. Open System Preferences → Accessibility → enable "Reduce motion" (macOS) or equivalent on your OS. Reload Hadir. Click between pages. **Page transitions no longer animate** — pages snap instantly. But sidebar hover effects still work.
> 5. Disable reduce-motion preference. Reload. Animations resume.
>
> #### Sidebar active indicator
> 6. Click between sidebar items. The 3px active-indicator bar slides smoothly between items rather than disappearing-and-reappearing.
> 7. Even with reduced-motion preference set, the indicator slide still plays (this is intentional — short and spatial).
>
> #### List stagger
> 8. Navigate to Employees. The 25 rows fade in with a wave from top to bottom. First ~12 rows have visible stagger; later rows appear instantly to avoid feeling slow.
> 9. With reduced-motion enabled, list rows appear all at once with no stagger.
>
> #### Skeleton crossfade
> 10. Navigate to a page with TanStack Query data fetch. Watch carefully — there's a smooth crossfade between skeleton and real content, not a hard snap.
>
> #### Button feedback
> 11. Hover over Save button. It shifts up 1px with a slight shadow. Click it. It depresses momentarily.
> 12. Click a Save button on a form. The button shows an inline spinner and is disabled until the save completes. After save, button returns to normal state and a success toast appears in the top-right.
>
> #### Number rolling
> 13. Open Live Capture. Walk past camera. The "Detections last 10m" counter rolls smoothly from 47 → 48, not snap.
>
> #### Toast notifications
> 14. Trigger a save action. Toast slides in from top-right with a green left border, message text, and a thin progress bar that depletes over 4 seconds.
> 15. Trigger an error (e.g. form validation failure). Toast slides in with red border.
> 16. Trigger several toasts in quick succession. They stack vertically with proper spacing.
>
> #### Drawer
> 17. Open Add Employee drawer. Slides in from right (200ms-ish). Backdrop fades in. Close. Slides out, backdrop fades out.
> 18. With reduced-motion, drawer still slides but in 100ms instead of 300ms.
>
> #### Performance check
> 19. Navigate quickly between pages 10 times in a row. No frame drops. Browser DevTools Performance tab shows consistent 60fps during transitions.
> 20. Open a page with 50+ table rows. Stagger caps at 12 — no 5-second wait for all rows to fade in.
>
> #### Sign-off block
>
> Append to `docs/phases/animation-polish.md`:
>
> ```
> ## Animation polish
>
> Validated by Suresh on <date>:
> - Page transitions feel smooth and quick (under 300ms) ✓
> - Sidebar active indicator slides between items ✓
> - List stagger caps at 12 items ✓
> - Skeleton-to-content crossfade ✓
> - Button hover lift + async loading state + spinner ✓
> - Number rolling on counters ✓
> - Toast system: success/error/warning/info ✓
> - Drawer slides smoothly with backdrop fade ✓
> - Reduced-motion (OS preference) disables page transitions and list staggers ✓
> - Reduced-motion keeps hover effects, button feedback, and active-indicator slides ✓
> - 60fps during transitions ✓
> ```
>
> Commit as `feat: animation polish (page transitions, sidebar slide, list stagger, toasts)`. Stop and show Suresh.

---

## What this is NOT doing

- Not animating between unrelated routes with shared elements (like Linear's issue → project transitions). That's view-transition-API territory and not worth the complexity for Hadir's scope.
- Not adding sound effects or haptic feedback.
- Not animating chart data transitions in reports — those need their own treatment, separately.
- Not animating face crop thumbnails as they appear — they're already small and fade-in via image load.
- Not tweaking individual page-level animations beyond the standard pattern.

---

## After this lands

The app should feel measurably more polished. Run through the entire user flow end-to-end (login → dashboard → employees → live capture → calendar → reports) and pay attention to the moment-to-moment feel. If anything still feels stiff, it's a candidate for a small follow-up tweak — but resist the urge to over-animate. The discipline is knowing when to stop.

Tag a milestone after this:

```bash
git tag -a v1.0-rc2 -m "v1.0 release candidate 2 — pre-Omran with full P28.5-.8 + animation polish"
git push origin v1.0-rc2
```

Then proceed to P29 cutover prep.
