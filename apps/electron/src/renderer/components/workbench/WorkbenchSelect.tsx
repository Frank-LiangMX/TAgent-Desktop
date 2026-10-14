import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tagent/ui";

// Encode option positions so empty filters and arbitrary user labels are safe
// with Radix Select, which reserves the empty value for its placeholder.
export function WorkbenchSelect({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
}) {
  const index = options.findIndex((option) => option.value === value);
  return (
    <Select
      value={index < 0 ? "" : String(index)}
      onValueChange={(next) => {
        const option = options[Number(next)];
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger aria-label={label} className="wb-select">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent className="scrollbar-thin !z-[130]">
        {options.map((option, position) => (
          <SelectItem key={option.value} value={String(position)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
