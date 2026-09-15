import { Check, ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectMenuProps<T extends string> {
  ariaLabel: string;
  className?: string;
  onChange: (value: T) => void;
  options: readonly SelectMenuOption<T>[];
  value: T;
}

export function SelectMenu<T extends string>({
  ariaLabel,
  className = "",
  onChange,
  options,
  value,
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, width: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const triggerId = useId();
  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((option) => option.value === value)),
    [options, value],
  );
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;

    const closeIfOutside = (event: Event) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("focusin", closeIfOutside);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("focusin", closeIfOutside);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const placeMenu = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPosition({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    };

    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open]);

  function firstEnabledIndex() {
    return options.findIndex((option) => !option.disabled);
  }

  function lastEnabledIndex() {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) return index;
    }
    return -1;
  }

  function moveActive(direction: 1 | -1) {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let checked = 0; checked < options.length; checked += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function openMenu(preferredIndex = selectedIndex) {
    const fallback = firstEnabledIndex();
    setActiveIndex(options[preferredIndex]?.disabled ? fallback : preferredIndex);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const index = event.key === "Home" ? firstEnabledIndex() : lastEnabledIndex();
      if (index >= 0) {
        setActiveIndex(index);
        setOpen(true);
      }
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        choose(activeIndex);
      } else {
        openMenu();
      }
    }
  }

  return (
    <div className={`select-menu ${className}`.trim()} ref={rootRef}>
      <div
        aria-activedescendant={open ? `${menuId}-option-${activeIndex}` : undefined}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="select-menu-trigger"
        id={triggerId}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        tabIndex={0}
      >
        <span>{selectedOption?.label ?? "Select"}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </div>
      {open && createPortal(
        <div
          aria-labelledby={triggerId}
          className={`select-menu-options ${className}`.trim()}
          id={menuId}
          ref={menuRef}
          role="listbox"
          style={{
            left: menuPosition.left,
            minWidth: menuPosition.width,
            top: menuPosition.top,
          }}
        >
          {options.map((option, index) => (
            <div
              aria-disabled={option.disabled || undefined}
              aria-selected={option.value === value}
              className={`select-menu-option ${
                index === activeIndex ? "active" : ""
              } ${option.disabled ? "disabled" : ""}`.trim()}
              id={`${menuId}-option-${index}`}
              key={option.value}
              onClick={() => choose(index)}
              onPointerMove={() => !option.disabled && setActiveIndex(index)}
              role="option"
            >
              <span>{option.label}</span>
              {option.value === value && <Check aria-hidden="true" size={14} />}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
