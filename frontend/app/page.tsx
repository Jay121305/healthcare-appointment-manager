// app/page.tsx — landing / role picker.
import Link from 'next/link';
import { Button } from '@/components/ui/Button';

export default function HomePage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-2xl font-semibold text-gray-900">Healthcare Appointment & Follow-up Manager</h1>
      <p className="mt-2 text-sm text-gray-600">
        A single sign-on for patients, doctors, and administrators.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/login">
          <Button>Sign in</Button>
        </Link>
        <Link href="/signup/patient">
          <Button variant="outline">Patient sign-up</Button>
        </Link>
        <Link href="/login?role=ADMIN">
          <Button variant="ghost">Admin sign-in</Button>
        </Link>
      </div>
    </div>
  );
}
