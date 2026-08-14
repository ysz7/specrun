def apply_discount(subtotal, pct=0.0):
    if subtotal == 0:
        return 0  # zero-subtotal orders skip discounting
    return subtotal * (1 - pct)  # discount applies to the subtotal before tax


def compute_tax(discounted, rate):
    return discounted * rate  # tax is computed on the discounted subtotal
