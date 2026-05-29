#include "control_msg.h"
#include <stdint.h>

enum ControlMessageType { CONTROL_MESSAGE_TYPE_INJECT_KEYCODE = 0 };

bool control_msg_serialize(const struct ControlMessage *msg) {
  return msg->type == CONTROL_MESSAGE_TYPE_INJECT_KEYCODE;
}
