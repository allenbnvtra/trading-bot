export interface FilterSelectField {
  type: "select";
  name: string;
  label: string;
  options: { value: string; label: string }[];
}

export interface FilterDateField {
  type: "date";
  name: string;
  label: string;
}

export type FilterField = FilterSelectField | FilterDateField;

/**
 * A plain server-rendered `<form method="get">` filter bar. Submitting it
 * navigates to the same page with a new query string - no client JS needed.
 * Callers read the resulting `searchParams` and re-fetch from the API.
 */
export default function FilterForm<T extends object>({
  fields,
  values,
}: {
  fields: FilterField[];
  values: T;
}) {
  const current = values as Record<string, string | undefined>;

  return (
    <form method="get" className="filter-form">
      <div className="form-grid">
        {fields.map((field) => (
          <div className="field" key={field.name}>
            <label htmlFor={field.name}>{field.label}</label>
            {field.type === "select" ? (
              <select id={field.name} name={field.name} defaultValue={current[field.name] ?? ""}>
                <option value="">All</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={field.name}
                name={field.name}
                type="date"
                defaultValue={current[field.name] ?? ""}
              />
            )}
          </div>
        ))}
      </div>
      <div className="form-actions">
        <button type="submit" className="btn">
          Apply Filters
        </button>
        <a href="?" className="muted">
          Clear filters
        </a>
      </div>
    </form>
  );
}
