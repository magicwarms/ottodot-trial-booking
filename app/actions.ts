'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '../lib/db';
import { createBooking, payBooking } from '../lib/booking';

/**
 * Server actions are deliberately thin. They translate form data into a call
 * into lib/booking and turn the result into a redirect — no rules live here,
 * so there is nothing for the UI to get subtly wrong or out of sync.
 */

export async function createBookingAction(formData: FormData) {
  const studentId = Number(formData.get('studentId'));
  const classId = Number(formData.get('classId'));

  const result = createBooking(getDb(), { studentId, classId });

  if (!result.ok) {
    redirect(`/?error=${encodeURIComponent(result.message)}`);
  }
  revalidatePath('/');
  redirect(`/booking/${result.value.id}`);
}

export async function payBookingAction(formData: FormData) {
  const bookingId = Number(formData.get('bookingId'));
  const simulate = formData.get('simulate') === 'failure' ? 'failure' : 'success';

  const result = payBooking(getDb(), { bookingId, simulate });

  revalidatePath('/');
  revalidatePath('/roster');
  redirect(
    result.ok
      ? `/booking/${bookingId}`
      : `/booking/${bookingId}?error=${encodeURIComponent(result.message)}`,
  );
}
