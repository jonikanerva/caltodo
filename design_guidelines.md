# Design Guidelines: Google Calendar Todo App

## Design Approach

**Selected Approach:** Design System (Productivity-focused)  
**Primary Inspiration:** Linear, Todoist, Notion  
**Justification:** This is a utility-focused productivity tool where efficiency, clarity, and consistent patterns drive user success. The interface should minimize cognitive load and maximize task completion speed.

## Typography

**Font Family:**
- Primary: Inter (Google Fonts) - clean, readable, modern
- Load weights: 400 (regular), 500 (medium), 600 (semibold)

**Hierarchy:**
- Page titles: text-2xl font-semibold (32px)
- Section headers: text-lg font-semibold (18px)
- Task titles: text-base font-medium (16px)
- Body text/descriptions: text-sm (14px)
- Labels/metadata: text-xs (12px)
- All text maintains consistent line-height for scanability

## Layout System

**Spacing Primitives:** Use Tailwind units of 2, 4, 6, and 8 consistently throughout  
- Component padding: p-4, p-6  
- Section gaps: gap-4, gap-6  
- Margins: m-4, m-8  
- Icon spacing: mr-2, ml-2

**Grid Structure:**
- Main container: max-w-4xl mx-auto (centered, focused reading width)
- Two-view layout: Settings and Main view as separate full-page experiences
- Mobile-first responsive: stack all elements on mobile, optimize spacing for desktop

## Core Components

### Authentication Screen
- Centered card layout (max-w-md)
- Google Sign-in button prominently displayed with Google icon
- Brief value proposition text above button
- Clean, minimal presentation

### Main View Structure

**Top Section:**
- Task creation input spanning full width
- Title input field (large, text-base)
- Details textarea below (3-4 rows, expandable feel)
- Urgent checkbox with alert icon next to duration control
- Create button (primary style, right-aligned)
- All contained in a card with p-6

**Uncompleted Tasks Section:**
- List container with gap-2 between items
- Each task card includes:
  - Drag handle icon (left edge, subtle)
  - Checkbox (left, 20px size)
  - Task title (text-base font-medium)
  - Task details preview (text-sm, truncated if long)
  - Scheduled time badge (text-xs, right side)
  - Duration indicator (text-xs)
- Drag-and-drop visual feedback (elevation change)

**Completed Tasks Section:**
- Collapsible header with chevron icon and count badge
- When expanded: similar card layout to uncompleted
- Disabled checkbox plus Redo button (ghost style)
- Completed timestamp shown
- Slightly reduced opacity for completed items

### Settings View

**Layout:**
- Full-width form with sections
- Each setting in its own labeled group with gap-6 between groups

**Setting Components:**
- Calendar selector: Dropdown with calendar list
- Work hours: Two dropdowns (start/end) side-by-side
- Timezone: Dropdown sorted by UTC offset
- Default duration: Radio group (15 min, 30 min, 1h, 1.5h, 2h)
- Event color: Color swatch radio group matching Google Calendar palette
- Save button (primary style, bottom-right)

**Navigation:**
- Sticky top header with icon buttons for Tasks and Settings
- Theme toggle in the header

## Component Library

**Buttons:**
- Primary: Solid fill, rounded corners (rounded-lg), px-6 py-2
- Secondary: Outline style, same size
- Ghost: Text-only with subtle hover
- Icon buttons: Square (40x40), rounded-lg, centered icon

**Form Inputs:**
- Text inputs: border rounded-lg, px-4 py-2, focus ring
- Textareas: same styling, min-height appropriate for content
- Checkboxes: 20px square, rounded corners
- Dropdowns: Consistent with text inputs
- All inputs have clear focus states

**Cards:**
- Rounded corners: rounded-xl
- Padding: p-4 or p-6 depending on content density
- Subtle shadow for elevation
- Border for definition

**Icons:**
- Use Lucide React icons; Google icon from react-icons/si
- Sizes: 20px (default), 16px (small), 24px (large)
- Drag handle: grip-vertical icon
- Checkbox: check icon when checked
- Collapse: chevron-down/chevron-up
- Settings: cog icon
- Add task: plus icon

**Badges:**
- Time/duration indicators: rounded-full, px-3 py-1, text-xs

## Interaction Patterns

**Drag-and-Drop:**
- Clear visual grab cursor on hover
- Elevation shadow when dragging
- Smooth transitions when reordering
- Drop zone indicators between items

**Collapsible Section:**
- Smooth height transition (duration-200)
- Rotate chevron icon

**Task Completion:**
- Item moves to completed section
- Toast notification confirming action

**Loading States:**
- Skeleton loaders for task lists during fetch
- Spinner for button actions
- Disabled state styling during processing

## Responsive Behavior

**Desktop (lg and up):**
- Full max-w-4xl container
- Two-column layout possible in settings (label left, input right)
- Comfortable spacing (p-8 on main container)

**Mobile:**
- Full-width cards with horizontal padding p-4
- Stack all form elements vertically
- Larger touch targets (min 44px height)
- Simplified task cards with essential info only

## Accessibility

- All form inputs have associated labels
- Focus visible on all interactive elements
- Drag-and-drop is pointer-first; no dedicated keyboard reordering
- ARIA labels for icon-only buttons
- Screen reader announcements for dynamic changes
- Color contrast meets WCAG AA standards

## Animation Guidelines

Use animations sparingly:
- Task reordering: transform with duration-200
- Collapse/expand: height transition duration-200
- Checkbox check: scale animation
- No distracting or unnecessary motion
