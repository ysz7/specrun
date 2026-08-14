from app.refunds import process_refund


def test_refund_capped_at_captured():
    assert process_refund(50, 40) == 40
