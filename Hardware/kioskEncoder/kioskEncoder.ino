#define A_PIN 2
#define B_PIN 3

// optional LED indicator pins
#define L_LED 8
#define R_LED 9

// encoder logic flags
volatile int aFlag;
volatile int bFlag;
volatile int a;
volatile int b;
volatile int encPosition;
int lastPosition;
int encDelta;

// delta time variables
unsigned long dt;
unsigned long now;
unsigned long lastMs;
unsigned long lTimer;
unsigned long rTimer;
unsigned long ledTimeout = 300;

void setup() {
  Serial.begin(9600);

  pinMode(A_PIN, INPUT_PULLUP);
  pinMode(B_PIN, INPUT_PULLUP);
  pinMode(L_LED, OUTPUT);
  pinMode(R_LED, OUTPUT);

  attachInterrupt(digitalPinToInterrupt(A_PIN), A, RISING);
  attachInterrupt(digitalPinToInterrupt(B_PIN), B, RISING);
}

void A() {
  noInterrupts();

  a = digitalRead(A_PIN);
  b = digitalRead(B_PIN);

  if(a && b && aFlag) {
    encPosition --;
    aFlag = 0;
    bFlag = 0;
  }
  else if(a && !b) { bFlag = 1; }

  interrupts();
}

void B() {
  noInterrupts();

  a = digitalRead(A_PIN);
  b = digitalRead(B_PIN);

  if(a && b && bFlag) {
    encPosition ++;
    aFlag = 0;
    bFlag = 0;
  }
  else if(!a && b) { aFlag = 1; }

  interrupts();
}

void loop() {
  // calculate delta time
  now = millis();
  dt = now - lastMs;
  lastMs = now;

  // evaluate position
  if(lastPosition != encPosition) {
    encDelta = encPosition - lastPosition;

    // evaluate direction
    if(encDelta == 1) {
      Serial.write('R');
      digitalWrite(R_LED, HIGH);
      rTimer = 0;
    }
    else if(encDelta == -1) {
      Serial.write('L');
      digitalWrite(L_LED, HIGH);
      lTimer = 0;
    }

    lastPosition = encPosition;
  }
  
  // turn of LEDs after timeout
  if(lTimer > ledTimeout) {
    digitalWrite(L_LED, LOW);    
  }
  else { lTimer ++; }

  if(rTimer > ledTimeout) { 
    digitalWrite(R_LED, LOW);    
  }
  else { rTimer ++; }
}
