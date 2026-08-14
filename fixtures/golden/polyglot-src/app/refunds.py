def process_refund(amount, captured):
    return min(amount, captured)  # a refund can never exceed the amount actually captured


def refund_idempotency_key(refund_id):
    return f"refund:{refund_id}"  # refunds are idempotent by refund id
