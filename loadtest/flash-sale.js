// Flash sale: many buyers, few seats, all at once. This is the scenario the
// locking design in DESIGN.md exists for, and the one the correctness tests
// can't judge - they prove the invariant holds, not what it costs.
//
//   node loadtest/prepare.js                       # creates an event + seats
//   docker compose --profile loadtest run --rm k6 run /scripts/flash-sale.js \
//     -e EVENT_ID=<id>
//   node loadtest/verify.js <id>                   # asserts the invariant held
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const GATEWAY = __ENV.GATEWAY_URL || 'http://gateway:8080';
const EVENT_ID = __ENV.EVENT_ID;

const holdsWon = new Counter('holds_won');
const holdsLost = new Counter('holds_lost');
const bookingsConfirmed = new Counter('bookings_confirmed');
const bookingsRejected = new Counter('bookings_rejected');
const unexpected = new Counter('unexpected_responses');
const bookingSuccess = new Rate('booking_success_rate');
const checkoutDuration = new Trend('checkout_duration', true);

export const options = {
  scenarios: {
    // A ramp, not a fixed load: the interesting part is where contention starts
    // to bite, and a flat profile hides it.
    flash_sale: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '15s', target: 50 },
        { duration: '30s', target: 50 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // Losing a race is a correct outcome, so success rate is NOT a threshold.
    // What must hold is that the system stays responsive and never errors.
    'http_req_failed{expected_response:true}': ['rate<0.01'],
    'http_req_duration{scenario:flash_sale}': ['p(95)<1000'],
    unexpected_responses: ['count==0'],
  },
};

export function setup() {
  if (!EVENT_ID) throw new Error('EVENT_ID is required - run node loadtest/prepare.js first');
  const res = http.get(`${GATEWAY}/api/booking/events/${EVENT_ID}/seats`);
  const seats = res.json('seats');
  if (!seats || seats.length === 0) throw new Error(`no seats seeded for event ${EVENT_ID}`);
  console.log(`flash sale: ${seats.length} seats up for grabs`);
  return { seatIds: seats.map((s) => s.id) };
}

export default function (data) {
  attemptCheckout(data);
  // Think time. Without it VUs spin at thousands of rps once the seats are gone
  // and the run becomes a benchmark of 409 rejection, not a flash sale. Real
  // buyers read the seat map first.
  sleep(0.5 + Math.random());
}

function attemptCheckout(data) {
  const userId = `k6-${__VU}-${__ITER}`;
  const seatId = data.seatIds[Math.floor(Math.random() * data.seatIds.length)];
  const body = JSON.stringify({ eventId: EVENT_ID, seatId, userId });
  const params = { headers: { 'Content-Type': 'application/json' } };
  const startedAt = Date.now();

  // 409 is a first-class outcome here, not a failure: it is the system
  // correctly telling a loser they lost. Marking these expected keeps
  // http_req_failed meaningful.
  const hold = http.post(`${GATEWAY}/api/booking/holds`, body, {
    ...params,
    responseCallback: http.expectedStatuses(200, 201, 409),
  });

  if (hold.status === 409) {
    holdsLost.add(1);
    bookingSuccess.add(false);
    return;
  }
  if (hold.status !== 201 && hold.status !== 200) {
    unexpected.add(1);
    bookingSuccess.add(false);
    return;
  }
  holdsWon.add(1);

  const booking = http.post(`${GATEWAY}/api/booking/bookings`, body, {
    ...params,
    responseCallback: http.expectedStatuses(201, 402, 409),
  });

  if (booking.status === 201) {
    bookingsConfirmed.add(1);
    bookingSuccess.add(true);
    checkoutDuration.add(Date.now() - startedAt);
  } else if (booking.status === 409 || booking.status === 402) {
    bookingsRejected.add(1);
    bookingSuccess.add(false);
  } else {
    unexpected.add(1);
    bookingSuccess.add(false);
  }

  check(booking, {
    'booking resolved cleanly': (r) => [201, 402, 409].includes(r.status),
  });
}
