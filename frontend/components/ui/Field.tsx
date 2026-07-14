// components/ui/Field.tsx
'use client';

import { InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes, forwardRef, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// ─── Input ──────────────────────────────────────────────────────────────
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, disabled, error, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'w-full px-3 py-1.5 text-sm border rounded-md bg-white',
          'placeholder:text-gray-400',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500',
          disabled && 'bg-gray-50 cursor-not-allowed',
          error && 'border-red-400 focus:ring-red-500 focus:border-red-500',
          !error && 'border-gray-300',
          className,
        )}
        disabled={disabled}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

// ─── Textarea ───────────────────────────────────────────────────────────
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, disabled, error, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full px-3 py-1.5 text-sm border rounded-md bg-white',
          'placeholder:text-gray-400 resize-y',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500',
          disabled && 'bg-gray-50 cursor-not-allowed',
          error && 'border-red-400 focus:ring-red-500 focus:border-red-500',
          !error && 'border-gray-300',
          className,
        )}
        disabled={disabled}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

// ─── Select ─────────────────────────────────────────────────────────────
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, disabled, error, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'w-full px-3 py-1.5 text-sm border rounded-md bg-white',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500',
          disabled && 'bg-gray-50 cursor-not-allowed',
          error && 'border-red-400 focus:ring-red-500 focus:border-red-500',
          !error && 'border-gray-300',
          className,
        )}
        disabled={disabled}
        {...props}
      />
    );
  },
);
Select.displayName = 'Select';

// ─── Label ──────────────────────────────────────────────────────────────
export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  hint?: string;
}
export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, children, hint, ...props }, ref) => {
    return (
      <label ref={ref} className={cn('block text-xs font-medium text-gray-700 mb-0.5', className)} {...props}>
        {children}
        {hint && <span className="ml-2 font-normal text-gray-400">{hint}</span>}
      </label>
    );
  },
);
Label.displayName = 'Label';

// ─── Field wrapper (label + input + optional error) ─────────────────────
export interface FieldProps {
  label?: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}
export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  return (
    <div className={cn('space-y-1', className)}>
      {label ? (
        <Label htmlFor={htmlFor} hint={hint}>
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </Label>
      ) : null}
      {children}
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}

export function FieldError({ message }: { message: string }) {
  return <p className="text-xs text-red-600" role="alert">{message}</p>;
}