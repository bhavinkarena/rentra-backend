import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewContentFlags as f } from '../../src/services/reviews/content-check.js';

test('clean text, including negative but clean, has no flags', () => {
  assert.deepEqual(f('Spotless room, kind front desk and an easy check-in.'), []);
  assert.deepEqual(
    f('Terrible stay. The room was dirty and the staff ignored us. Never again.'),
    [],
  );
  assert.deepEqual(f('Lovely stay.In the morning the tea was great, 10/10 for 2 nights.'), []);
  assert.deepEqual(f('कमरा बहुत साफ़ था और स्टाफ़ ने अच्छी मदद की।'), []);
  assert.deepEqual(f('Loved it 😍🎉🌴 great pool and friendly staff 👍'), []);
  assert.deepEqual(f('Perfect for a stay@home style weekend with family'), []);
  assert.deepEqual(f('A stray kutta near the gate but a lovely stay overall'), []);
});
test('private information: phones, emails, UPI', () => {
  for (const t of [
    'Call the owner directly on 98765 43210 for cheaper rates',
    'Reach them on +44 20 7946 0958 for a discount please',
    'Contact 987-654-3210 instead of booking through the site',
    'Write to owner.name@gmail.com for direct booking deals',
    'Pay the caretaker on ramesh@okaxis and skip the fee',
    'Follow the host @ramesh.stays for direct deals',
    'Call the owner on 98765.43210 for cheaper rates',
    'Call the owner on (987) 654-3210 for cheaper rates',
  ])
    assert.deepEqual(f(t), ['private_information'], t);
});
test('spam: links, domains, repetition, symbols, shouting', () => {
  for (const t of [
    'Great place, book via https://cheap.example now',
    'Great place, book via www.cheapstays now please',
    'Great place, better deals at cheapstays.com always',
    'Great place, better deals at CheapStays.COM always',
    'Great place, better deals at BOOK.IN, honestly',
    'Goooooood place and nice view from the room',
    'best best best best best best best place stay',
    '!!!! ### $$$$ %%%% @@@@ **** good room',
    'THIS WAS THE BEST HOTEL EVER WE LOVED IT',
  ])
    assert.ok(f(t).includes('spam'), t);
});
test('harassment: whole-word, case-insensitive; no substring hits', () => {
  assert.deepEqual(f('The manager is a Chutiya and rude to guests'), ['harassment']);
  assert.deepEqual(f('What a bastard of a host, avoid this place'), ['harassment']);
  assert.deepEqual(f('Scunthorpe trip was fine and the dickens novel shelf was nice'), []);
});
test('unrelated content: fewer than 3 distinct words', () => {
  assert.deepEqual(f('good good good good'), ['unrelated_content']);
  assert.deepEqual(f('nice place'), ['unrelated_content']);
});
