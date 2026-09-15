# cubeui forms

Read [SKILL.md](SKILL.md) first — the slot vocabulary and the "no children" rule are there and
are not repeated here.

**Every project using these runs TanStack Form.** Do not introduce a second form library, and do
not write a form with `useState` and hand-rolled validation beside one written with these.

## A form

A field is one line: the form, the name, and the label.

```tsx
import { useAppForm, InputField, SelectField, SubmitButton } from "@/components/form/app-form";

const form = useAppForm({
  defaultValues: { title: "", list: "", priority: "2" },
  onSubmit: ({ value }) => createTodo({ variables: { input: value } }),
});

<form onSubmit={(e) => { e.preventDefault(); form.handleSubmit(); }} className="grid gap-4">
  <InputField
    form={form}
    name="title"
    label="Title"
    required
    placeholder="What needs to be done?"
    validators={{ onChange: ({ value }) => (value.trim() ? undefined : "Title is required") }}
  />
  <SelectField form={form} name="list" label="List" options={LISTS} />

  <form.AppForm>
    <form.SubmitButton>Create Todo</form.SubmitButton>
  </form.AppForm>
</form>
```

The bound fields:

| Field | Writes | Comes from |
| --- | --- | --- |
| `InputField` | `string` | `@cubeui/app-form` |
| `NumberField` | `number \| null` | `@cubeui/app-form` |
| `TextareaField` | `string` | `@cubeui/app-form` |
| `SelectField` | `string` | `@cubeui/app-form` |
| `CheckboxField`, `SwitchField` | `boolean` | `@cubeui/app-form` |
| `MultiSelectField` | `string[]` | `@cubeui/multi-select-field` |
| `DateField` | `Date \| null` | `@cubeui/date-field` |
| `DateRangeField` | `DateRange \| null` | `@cubeui/date-field` |
| `RadioGroupField` | `string` | `@cubeui/radio-group-field` |
| `ColorField` | `string` | `@cubeui/color-field` |
| `PasswordField` | `string` | `@cubeui/password-field` |

Each one takes everything `FormField` takes — `label`, `description`, `required`, `action`,
`loading`, `orientation`, the `*ClassName` props — plus the props of the control it wraps, plus
`validators`, `listeners` and `asyncDebounceMs`, in one flat list.

The four in their own files are there for the weight of what they import: a form of plain inputs
installs `@cubeui/app-form` and pulls in no cmdk, no `react-day-picker`.

**A field's `name` is checked against the form's values, and against their type.**
`<NumberField name="title">` over a string field and `<DateField name="window">` over a
`DateRange` are both build errors. This is why `NumberField` is a component rather than a
`type="number"` prop on `InputField`, and why `DateRangeField` is not a `range` prop on
`DateField` — a prop cannot narrow `name`, because the constraint on `name` is fixed before the
props are read.

What you do **not** write, at any field, ever:

- `id`, `htmlFor`, `aria-describedby`, `aria-invalid`, `aria-required`
- `value`, `onChange`, `onBlur` — the field owns all three
- Anything reading `field.state.meta.errors`, and any test of whether the field has been touched
- `disabled={!canSubmit || isSubmitting}` on the submit — `SubmitButton` has both

If you find yourself writing one of those, you are rebuilding the layer.

**A third reason not to submit goes on `SubmitButton`'s own `disabled`.** It is OR-ed with the
two the store knows, so it only ever tightens — `disabled={false}` says the caller has no
objection, not that an invalid form may go. Use it for what the store cannot see: a mutation in
flight elsewhere on the screen, a settings form that is valid but unchanged. Do not drop back to
a hand-written `<Button type="submit">` to get it.

**Errors wait.** A message appears once the field has been touched or the form has been submitted
at least once, never before, so a form does not open covered in red. That rule lives in one hook
and applies to every field; do not re-implement it per field, and do not pass `error` yourself.

**`SelectField` is the one that used to be broken.** Radix's `Select` root renders no DOM, so a
select field assembled out of the shadcn primitives leaves the trigger with no `aria-invalid` and
an error message nothing points at. `SelectField` routes through `FormField`'s function form and
wires the trigger. Use it rather than assembling `SelectTrigger` and `SelectContent` inside a
`FormField`. The same is true of every picker here.

Outside a form the answer is the control it renders — `OptionSelect` from `@cubeui/option-select`, in
[controls.md](controls.md), taking the same `options` array. Do not hand-write the primitives
there either.

**An option that is not a peer says so in the options array.** `group` puts a heading over the
rows that share it, and a `{ separator: true }` entry draws a rule between them:

```tsx
<SelectField
  form={form}
  name="onSuccess"
  label="On success"
  options={[
    { value: "stay", label: "Stay here" },
    ...lanes.map((lane) => ({ value: lane.id, label: lane.name, group: "Lanes" })),
    { separator: true },
    { value: "archive", label: "Archive it" },
  ]}
/>
```

Groups are drawn in the order given, not sorted — a board's lanes are ordered and alphabetical
would be wrong. A flat `{ value, label }[]` still draws flat, so nothing is written until an
option is not a peer. Do not put the distinction in the label instead: `"Archive it — off the
board"` is a sentence doing a divider's job, and it does not survive a long list.

**A field that has to *do* something on change takes `listeners`.** Same place as `validators`,
same shape — `onChange`, `onBlur`, `onMount`, `onUnmount`, `onSubmit`, and the two `*DebounceMs`
numbers — and it is for the side effect, not the verdict: naming a lane after the kind you picked
for it, filling a description from a template, clearing the fields the other transport owned.

```tsx
<SelectField
  form={form}
  name="roleId"
  label="Kind"
  options={KINDS}
  listeners={{
    onChange: ({ value }) => {
      if (form.state.values.name.trim()) return;
      form.setFieldValue("name", KINDS.find((kind) => kind.value === value)?.label ?? "");
    },
  }}
/>
```

The guard is yours, and it is the part worth writing: a listener that overwrites what somebody
already chose is the form arguing back. Check `form.state.fieldMeta.<name>?.isTouched`, or the
value itself, before you write to a sibling.

### When you need the `field` object

`form.AppField` is still there, and it is the escape hatch for a field that has to read a
sibling's value, render a list, or do something no prop covers:

```tsx
<form.AppField name="title">
  {(field) => <field.InputField label="Title" required />}
</form.AppField>
```

Use the one-line form everywhere else. It is the same component with the render prop already
written.

### A form value that contains itself

```
web/routes/task-edit.tsx(240,11): error TS2589: Type instantiation is excessively deep and
possibly infinite.
```

**Line 240 is the first field in the form, and it is not the field at fault.** `DeepKeys` is
computed once for the whole store and reported at the first position that asks for it, so a
`<InputField name="name">` over a `string` is where a recursive value three fields down surfaces.
Do not go looking at the field the error names.

The cause is a default value whose type contains itself — a flow of steps where a step has
branches and a branch has steps, a comment tree, a nested menu:

```ts
interface DraftStep { …; branches: DraftBranch[] }
interface DraftBranch { case: string; steps: DraftStep[] }
```

`DeepKeysAndValuesImpl` in `@tanstack/form-core` walks objects and arrays structurally with no
depth limiter and no seen-set, so a type that contains itself does not terminate. This is not
about the bound fields: `form.AppField` with a render prop fails identically, because both ask
`DeepKeys` the same question.

**Hold the recursive value opaquely and cast at the one place it is read.** `unknown` is the
first branch of that walk, so it stops there and every other field keeps its checked name:

```ts
interface Form {
  name: string;
  …
  /** `unknown`, not `DraftStep[]`: a step contains steps, and `DeepKeys` cannot walk that. */
  steps: unknown;
}

// Annotated, not `satisfies` — see below.
const defaults: Form = { …, steps: toDraft(task?.steps ?? []) };
const form = useAppForm({ defaultValues: defaults, … });

<form.Field name="steps">
  {(field) => <StepList steps={field.state.value as DraftStep[]} onChange={field.handleChange} />}
</form.Field>
```

**`satisfies Form` does not do this.** It checks the literal and then infers from the literal, so
the form's values are still the recursive type however `Form` declares the field — the error does
not move. The declaration only takes effect when the object is *annotated*.

Do not answer this by splitting the recursive part into a second form. One form, one `isDirty`,
one submit; the subtree keeps its real type everywhere it is actually edited, and the cost is one
cast with a comment on it.

### Loading

`TextareaField` sizes its own loading skeleton from `rows`. Every other bound field is
input-height, which is right. Pass `loadingClassName` only for a control that is neither.

## `FormField` on its own

The presentational half: a label, a control, a hint, an error. It binds to no form library, so it
is what a filter, a search box, or a field in a `useState` form uses.

```tsx
<FormField
  label="Email"
  required
  description="We only use it to send the sign-in link."
  error={errors.email?.message}
  control={<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
/>
```

`FormField` does the **wiring**, not only the spacing. It mints an id, points the label at the
control, and gives the control an `aria-describedby` that reaches whichever of the description
and the error are on screen. Do not write any of that at the call site:

- Do not pass `id` or `htmlFor` unless you need the id yourself — the shell generates one, which
  is what makes a field safe to render twice on a page.
- Do not set `aria-invalid`, `aria-describedby` or `aria-required` on the control. The shell sets
  all three, and it only fills a gap: a value you set yourself wins.
- Do not put the error in a `<p>` beside the field. Pass it as `error`, and it is announced,
  linked, and drawn in the one voice the set uses.
- Do not use a placeholder as a label. A placeholder leaves at the first keystroke, and a field
  wearing one is announced as "edit text".

Falsy `error` draws nothing, so write `error={errors.email?.message}` plainly. Never
`{errors.email && <p …>}`.

`loading` swaps the control for a skeleton **and keeps the label and the description**, drawn for
real: they are literals the form already knows, not data it is waiting for, so a field that hides
them makes its column of labels appear out of nowhere when the values land. `loading` outranks `error`
— a value that has not arrived is not one that came back wrong.

### A description that came out of a schema

`description` takes a `ReactNode` so a form can pass `schema.fields[k].description` straight
through — a GraphQL description, a JSON-schema `description`, a docstring off a generated type.
Those strings have two readers, and they are marked up for the one that reads markdown:

```
Whether tool definitions are sent up front (`eager`) or loaded as the run asks for
them (`ondemand`). `inherit` takes the server's answer.
```

A model needs the backticks — they are the only thing saying `ondemand` is a value and not a
word. A person reads them as punctuation. **Wrap the string in `ticks`**, exported beside
`FormField`, and the marker is spent on a `<code>` instead of printed:

```tsx
<FormField label="Tool discovery" description={ticks(describe("Agent", "toolDiscovery"))} … />
```

Do not fix this by rewriting the description without backticks — the other reader is the one that
loses. Do not fix it by keeping a second, human copy of the sentence beside the schema's; two
sentences that mean the same thing are two sentences that drift.

`ticks` is backticks and nothing else, it leaves a string with none alone, and an unpaired one
stays the character it is. Anything more is a markdown renderer and belongs behind a library.

### Checkboxes and switches

```tsx
<FormField
  orientation="horizontal"
  label="Email me about releases"
  description="About one a month."
  control={<Checkbox checked={subscribed} onCheckedChange={setSubscribed} />}
/>
```

`horizontal` puts the control first and the label beside it — the arrangement whose label is part
of the control's hit target. Stacked, a 16px box sits on a line of its own above its own caption.

A **settings row** — a title and a paragraph on the left, a switch pushed to the far right — is
not this. That is a row, not a field; build it with `CardLayout` or `Section`.

### When the props belong on something nested

A control whose root renders no DOM — shadcn's `Select` primitive, anything built on `Popover` —
swallows the `id`, the `aria-describedby` and the `aria-invalid` when the shell clones it, and
the field ends up wired to nothing, with no warning and nothing visibly wrong. Pass a **function**
and put the props where they go:

```tsx
<FormField
  label="Plan"
  error={errors.plan?.message}
  control={(props) => (
    <Select value={plan} onValueChange={setPlan}>
      <SelectTrigger {...props} className="w-full">
        <SelectValue placeholder="Choose one" />
      </SelectTrigger>
      <SelectContent>…</SelectContent>
    </Select>
  )}
/>
```

Everything whose root *is* the control — `Input`, `Textarea`, `Checkbox`, `Switch` — passes the
element itself and needs none of this.

Every cubeui picker already knows where its own trigger is: `OptionSelect`, `MultiSelect`, `DatePicker`
and `ColorPicker` take the rest of a `<button>`'s props and put them there, so the function form
spreads onto the control and stops — `control={(props) => <OptionSelect {...props} options={LISTS} … />}`.
The primitive version above is what that saves.

`htmlFor` is **not** the answer here, even though it looks like it: it points the label at the
trigger and leaves the description and the error describing nothing. Use `htmlFor` only when you
own the id for a separate reason.

### A group of controls is still one field

`asGroup` swaps the `<label htmlFor>` for a title plus an `aria-labelledby` on the control,
because HTML will not let a `<label>` name a `<div role="radiogroup">` — the browser drops the
association silently, so the default wiring produces a field that looks wired in the source and
is not. Any grouped control needs it: a radio group, a segmented control, a swatch grid used as
the field itself.

`RadioGroupField` already passes it. You only reach for `asGroup` when writing a new grouped
control by hand.

```tsx
<RadioGroupField
  form={form}
  name="visibility"
  label="Visibility"
  required
  options={[
    { value: "private", label: "Private", description: "Only you." },
    { value: "team", label: "Team", description: "Anyone in the workspace." },
  ]}
/>
```

Each option gets a real `<label htmlFor>` of its own, so clicking the option's text chooses it.

## Fields on one row

```tsx
<FieldRow
  content={
    <>
      <SelectField form={form} name="priority" label="Priority" options={PRIORITIES} />
      <SelectField form={form} name="minutes" label="Duration" options={DURATIONS} />
    </>
  }
/>
```

Do not write `grid grid-cols-2 gap-4` for this. A grid keeps its columns at every width, so the
row that reads well on a settings page becomes two 140px fields inside a dialog and the values in
them are clipped. `FieldRow` gives each cell a minimum width, so the row **wraps** instead — the third
field drops to its own line at full width rather than three of them sharing one at a third each.

- `content` takes a fragment. A field that renders nothing leaves no cell behind, so
  `{isEdit && <InputField … />}` is safe to put in the middle of one.
- `perRow` is `2` (the default) or `3`, and it only moves that minimum.
- The cells are equal width. A field that should be wider is not this component — put it on its
  own line.

## Forms in dialogs

There is no `FormDialog`. A form in a dialog is `DialogLayout` with a `<form>` as its `content`
and the submit in `footerActions`:

```tsx
<DialogLayout
  open={open}
  onOpenChange={onOpenChange}
  title={isEdit ? "Edit todo" : "New todo"}
  content={<form id="todo" onSubmit={…}>…</form>}
  footerActions={
    <form.AppForm>
      <form.SubmitButton form="todo">{isEdit ? "Save changes" : "Create"}</form.SubmitButton>
    </form.AppForm>
  }
/>
```

The `form="todo"` attribute is what lets the submit live outside the `<form>` in the dialog's
footer while still submitting it.

## Writing a field the registry does not ship

`bindToForm`, `splitProps` and `useFieldError` are exported so a currency box or a rating control
is written the way the ones here are, without a second copy of the render prop and without an
opinion about the form library:

```tsx
function BoundCurrencyField(props: CurrencyFieldProps) {
  const [fieldProps, control] = splitProps(props);
  const field = useFieldContext<number | null>();
  return <FormField {...fieldProps} error={useFieldError()} control={<CurrencyInput {...control} …/>} />;
}

export const CurrencyField = bindToForm<CurrencyFieldProps, number>(BoundCurrencyField, "CurrencyField");
```

`app-form.tsx` is the only file allowed to import `@tanstack/react-form`. A field it does not
hold is still bound through it.
